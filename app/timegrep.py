"""Time Grep: grep through every version of an article, or through the whole encyclopedia as it stood
on a given day. Both run directly against the system-versioned `article` table:

  one article  ->  FOR SYSTEM_TIME ALL      + REGEXP / REGEXP_INSTR on every stored version
  whole wiki   ->  FOR SYSTEM_TIME AS OF t  + LIKE, over the articles whose current text matches (FULLTEXT)

Results are cached in memory and in viz_timegrep_cache (scripts/build_timegrep.py warms the presets).
"""
import datetime as dt, functools, json, re, threading, time, zlib
from concurrent.futures import ThreadPoolExecutor
import pymysql
from flask import Blueprint, Response, jsonify, request
from app.db import rows

bp = Blueprint("timegrep", __name__)
MAX_PATTERN = 80
TIMEOUT_S = 5
CAP = 400                                   # mode 2: at most this many candidate articles
SNAP_DATES = ["2005-01-01", "2008-01-01", "2011-01-01", "2014-01-01", "2017-01-01",
              "2020-01-01", "2023-01-01", "2026-10-01"]
_pool = ThreadPoolExecutor(max_workers=8)   # threads keep their own DB connection (app.db)
# Flask serves each request on a fresh thread, and a fresh DB connection costs ~0.7 s over the tunnel.
# Request work therefore runs on these long-lived threads, which keep their connections warm.
_io = ThreadPoolExecutor(max_workers=4)

GREP_SQL = """SET STATEMENT max_statement_time={t} FOR
SELECT a.row_start, a.rev_id, a.user, a.anonymous, a.comment, a.len,
       a.pos > 0 AS hit,
       IF(a.pos > 0, SUBSTRING(a.text, GREATEST(1, a.pos - 300), 640), NULL) AS around,
       r.is_revert
FROM (SELECT row_start, rev_id, user, anonymous, comment, len, text,
             REGEXP_INSTR(text, %s) AS pos
      FROM article FOR SYSTEM_TIME ALL
      WHERE page_id = %s) a
LEFT JOIN revision r ON r.rev_id = a.rev_id
ORDER BY a.row_start""".replace("{t}", str(TIMEOUT_S))

# The readable form shown on the page (same query, minus the snippet plumbing).
GREP_SQL_SHOWN = """SET STATEMENT max_statement_time=5 FOR
SELECT row_start, rev_id, user, comment,
       text REGEXP @pattern AS hit,
       SUBSTRING(text, REGEXP_INSTR(text, @pattern) - 320, 760) AS around
FROM article FOR SYSTEM_TIME ALL        -- every version, with Wikipedia's real edit times
WHERE page_id = @page
ORDER BY row_start"""

CAND_SQL = """SELECT c.page_id, c.title FROM current_article c
JOIN viz_timegrep_pages p ON p.page_id = c.page_id
WHERE c.lang = 'fi' AND MATCH(c.title, c.text) AGAINST (%s IN BOOLEAN MODE)
LIMIT %s"""

ASOF_SQL = """SET STATEMENT max_statement_time={t} FOR
SELECT page_id, title, rev_id, row_start,
       SUBSTRING(text, GREATEST(1, LOCATE(%s, text) - 220), 520) AS around
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id IN ({ids}) AND text LIKE %s"""

ASOF_SQL_SHOWN = """-- 1. candidates: today's articles that contain the phrase (FULLTEXT index)
SELECT page_id FROM current_article
WHERE lang = 'fi' AND MATCH(title, text) AGAINST ('"@phrase"' IN BOOLEAN MODE)
LIMIT 400;

-- 2. what those articles said on each date (run once per date, in parallel)
SET STATEMENT max_statement_time=5 FOR
SELECT page_id, title, rev_id, row_start,
       SUBSTRING(text, LOCATE(@phrase, text) - 220, 520) AS around
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2008-01-01 00:00:00'
WHERE page_id IN (@candidates) AND text LIKE '%@phrase%'"""


class UserError(Exception):
    pass


# ---------------------------------------------------------------- wikitext snippet -> readable sentence
_REF = re.compile(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", re.S)


def _clean_window(t):
    t = re.sub(r"<!--.*?-->", "", t, flags=re.S)
    t = _REF.sub("", t)
    t = re.sub(r"^[^<]*?</ref>", "", t, flags=re.S)       # window began inside a <ref>
    t = re.sub(r"<ref[^>]*>[^<]*$", "", t, flags=re.S)    # window ends inside a <ref>
    for _ in range(3):
        t = re.sub(r"\{\{[^{}]*\}\}", "", t)
    t = re.sub(r"^[^{]*?\}\}", "", t)
    t = re.sub(r"\{\{[^}]*$", "", t)
    # the match sits inside a link target ([[Carl Gustaf Emil Mannerheim|marsalkka]], [[Luokka:X]]): keep the target
    t = re.sub(r"\[\[([^\]|\x01]*\x01[^\]|\x02]*\x02[^\]|]*)(?:\|[^\]]*)?\]\]", r"\1", t)
    t = re.sub(r"\[\[(?:Tiedosto|Kuva|File|Image|Luokka|Category):[^\]\x01]*\]\]", "", t)
    t = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", t)
    t = re.sub(r"\[\[([^\]]*)\]\]", r"\1", t)
    t = re.sub(r"\[https?://\S+ ([^\]]*)\]", r"\1", t)
    t = re.sub(r"</?[a-zA-Z][^>]*>", "", t)
    t = t.replace("'''", "").replace("''", "").replace("&nbsp;", " ")
    return t


_BOUND = re.compile(r"(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9\"'(])|\n+")


@functools.lru_cache(maxsize=20000)
def sentence_of(around, pattern):
    """The sentence of `around` (a wikitext window) containing the first match, markup removed.
    Returns (text, match_start, match_end) or (text, -1, -1) when the match fell inside markup."""
    if not around:
        return None
    m = re.compile(pattern, re.I).search(around)
    if not m:                               # PCRE and Python disagree: show the raw window centre
        return (_squash(around[200:420]), -1, -1)
    marked = around[:m.start()] + "\x01" + around[m.start():m.end()] + "\x02" + around[m.end():]
    t = _clean_window(marked)
    a, b = t.find("\x01"), t.find("\x02")
    if a < 0 or b < 0:                      # match sat inside markup: show the raw wikitext around it
        lo = max(0, m.start() - 110)
        pre, mid = _squash(around[lo:m.start()]), _squash(around[m.start():m.end()])
        raw = _squash(around[lo:m.end() + 110])
        a = raw.find(mid, max(0, len(pre) - 2))
        return (("…" if lo else "") + raw + "…", a + (1 if lo else 0) if a >= 0 else -1,
                a + (1 if lo else 0) + len(mid) if a >= 0 else -1)
    starts = [x.end() for x in _BOUND.finditer(t, 0, a)]
    s0 = starts[-1] if starts else 0
    e = _BOUND.search(t, b)
    s1 = e.start() if e else len(t)
    s = t[s0:s1]
    s = re.sub(r"^[\s*#:;|=!]+", "", s)
    s = _squash(s)
    a, b = s.find("\x01"), s.find("\x02")
    s = s.replace("\x01", "").replace("\x02", "")
    if a >= 0 and b >= 0:
        b -= 1
    if len(s) > 340:                        # keep a readable window around the match
        lo = max(0, a - 160)
        hi = min(len(s), max(b, 0) + 160)
        s2 = ("…" if lo else "") + s[lo:hi] + ("…" if hi < len(s) else "")
        shift = (1 if lo else 0) - lo
        return (s2, a + shift, b + shift)
    return (s, a, b)


def _squash(s):
    return re.sub(r"\s+", " ", s).strip()


def compile_rx(pattern):
    if not pattern or not pattern.strip():
        raise UserError("Type a word, phrase or regular expression.")
    if len(pattern) > MAX_PATTERN:
        raise UserError(f"Pattern longer than {MAX_PATTERN} characters.")
    if re.search(r"\\[1-9]|\(\?[<=!]|\(\?R|\(\?\d", pattern):
        raise UserError("Back-references, look-arounds and recursion are not allowed.")
    try:
        rx = re.compile(pattern, re.I)
    except re.error as e:
        raise UserError(f"Not a valid regular expression: {e}")
    if rx.search(""):
        raise UserError("That pattern matches the empty string, so it would light up every version.")
    return rx


def _iso(t):
    return t.isoformat(sep=" ", timespec="seconds") if isinstance(t, dt.datetime) else t


# ---------------------------------------------------------------- cache (memory -> viz table -> compute)
_mem, _lock = {}, threading.Lock()


_errs = {}                                  # key -> (time, message): recent UserErrors, kept 10 min


def cached(key, fn):
    with _lock:
        if key in _mem:
            return _mem[key], "memory"
        e = _errs.get(key)
        if e and time.time() - e[0] < 600:
            raise UserError(e[1])
    return _io.submit(_cached_db, key, fn).result()


def _cached_db(key, fn):
    r = rows("SELECT body FROM viz_timegrep_cache WHERE k=%s", (key,))
    if r:
        body = json.loads(zlib.decompress(r[0]["body"]))
        with _lock:
            _mem[key] = body
        return body, "viz_timegrep_cache"
    try:
        body = fn()
    except UserError as e:
        with _lock:
            _errs[key] = (time.time(), str(e))
        raise
    try:
        rows("REPLACE INTO viz_timegrep_cache (k, body, built) VALUES (%s, %s, UTC_TIMESTAMP())",
             (key, zlib.compress(json.dumps(body, default=str, separators=(",", ":")).encode(), 6)))
    except pymysql.MySQLError:
        pass
    with _lock:
        if len(_mem) > 300:
            _mem.clear()
        _mem[key] = body
    return body, "live"


# ---------------------------------------------------------------- mode 1: one article, every version
def grep_article(page_id, pattern):
    rx = compile_rx(pattern)
    meta = rows("SELECT page_id, title, versions FROM viz_timegrep_pages WHERE page_id=%s", (page_id,))
    if not meta and not rows("SELECT 1 FROM revision WHERE page_id=%s LIMIT 1", (page_id,)):
        raise UserError("No article with that page id in the History of Finland set.")
    if not meta:
        if not rows("SELECT 1 FROM article FOR SYSTEM_TIME ALL WHERE page_id=%s LIMIT 1", (page_id,)):
            raise UserError("No stored text for that article (only ~17k articles have their full history loaded).")
        meta = [{"page_id": page_id, "title": None, "versions": None}]
    t0 = time.perf_counter()
    try:
        vs = rows(GREP_SQL, (pattern, page_id))
    except pymysql.err.OperationalError as e:
        if e.args and e.args[0] in (1969, 3024):
            raise UserError(f"The query ran past the {TIMEOUT_S} s limit (max_statement_time) and MariaDB stopped it.")
        raise
    except pymysql.err.InternalError as e:
        raise UserError(f"MariaDB rejected the pattern: {e.args[-1]}")
    except pymysql.err.ProgrammingError as e:
        raise UserError(f"MariaDB rejected the pattern: {e.args[-1]}")
    ms = (time.perf_counter() - t0) * 1000
    title = meta[0]["title"] or (vs and rows("SELECT title FROM article FOR SYSTEM_TIME ALL WHERE page_id=%s "
                                               "ORDER BY row_start DESC LIMIT 1", (page_id,))[0]["title"]) or str(page_id)

    out, events, wordings = [], [], []
    prev_hit, present_s, total_s = None, 0.0, 0.0
    end_t = dt.datetime(2026, 10, 1)
    for i, v in enumerate(vs):
        hit = bool(v["hit"])
        t = v["row_start"]
        t_next = vs[i + 1]["row_start"] if i + 1 < len(vs) else end_t
        span = max(0.0, (t_next - t).total_seconds())
        total_s += span
        if hit:
            present_s += span
        sent = sentence_of(v["around"], pattern) if hit else None
        rec = {"t": _iso(t), "rev": v["rev_id"], "user": v["user"], "anon": bool(v["anonymous"]),
               "c": (v["comment"] or "")[:110], "hit": hit, "rv": bool(v["is_revert"]), "len": v["len"]}
        out.append(rec)
        if hit and sent:
            if not wordings or wordings[-1]["s"] != sent[0]:
                same = next((w for w in wordings if w["s"] == sent[0]), None)
                if same:                                # an older wording came back (often a revert)
                    same["spans"].append([rec["t"], rec["t"]])
                    same["n"] += 1
                    wordings.append(wordings.pop(wordings.index(same)))
                else:
                    wordings.append({"s": sent[0], "a": sent[1], "b": sent[2], "first": rec["t"], "rev": rec["rev"],
                                     "user": rec["user"], "c": rec["c"], "n": 1, "spans": [[rec["t"], rec["t"]]]})
            else:
                wordings[-1]["n"] += 1
            wordings[-1]["spans"][-1][1] = _iso(t_next)
        if prev_hit is not None and hit != prev_hit or (prev_hit is None and hit):
            kind = "first" if (hit and not any(e["kind"] == "first" for e in events)) else ("back" if hit else "gone")
            ev = {"kind": kind, "i": i, **rec}
            if hit and sent:
                ev["sentence"], ev["a"], ev["b"] = sent
            if not hit:                                     # what the phrase looked like just before
                ev["before"] = next((w["s"] for w in reversed(wordings)), None)
            events.append(ev)
        prev_hit = hit
    # how long each absence lasted and whether it was undone by a revert
    for k, e in enumerate(events):
        if e["kind"] == "gone":
            nxt = next((x for x in events[k + 1:] if x["kind"] == "back"), None)
            if nxt:
                d = (dt.datetime.fromisoformat(nxt["t"]) - dt.datetime.fromisoformat(e["t"]))
                e["absent_s"] = d.total_seconds()
                e["undone_by"] = {"rev": nxt["rev"], "user": nxt["user"], "rv": nxt["rv"], "t": nxt["t"]}
                e["edits_absent"] = nxt["i"] - e["i"]
    gone = [e for e in events if e["kind"] == "gone"]
    quick = [e for e in gone if e.get("absent_s") is not None and e["absent_s"] < 86400]
    # keep the wordings list readable: the most durable ones, in order of first appearance
    for w in wordings:
        w["dur"] = sum((dt.datetime.fromisoformat(b) - dt.datetime.fromisoformat(a)).total_seconds() for a, b in w["spans"])
    wordings.sort(key=lambda w: w["first"])
    many = len(wordings)
    if many > 24:
        keep = {id(w) for w in sorted(wordings, key=lambda w: -w["dur"])[:24]}
        wordings = [w for w in wordings if id(w) in keep]
    nhit = sum(1 for v in out if v["hit"])
    cols = {k: [v[k] for v in out] for k in ("t", "rev", "user", "anon", "c", "hit", "rv")}
    for k in ("anon", "hit", "rv"):
        cols[k] = "".join("1" if x else "0" for x in cols[k])
    return {
        "page_id": page_id, "title": title, "pattern": pattern, "ms": round(ms), "v": cols,
        "events": events, "wordings": wordings, "wordings_total": many,
        "stats": {"n": len(out), "hits": nhit, "time_share": present_s / total_s if total_s else 0,
                  "removals": len(gone), "quick_restores": len(quick),
                  "revert_restores": sum(1 for e in gone if e.get("undone_by", {}).get("rv")),
                  "still_there": bool(out and out[-1]["hit"])},
        "sql": GREP_SQL_SHOWN,
    }


@bp.get("/grep")
def api_grep():
    pattern = (request.args.get("q") or "").strip()
    try:
        page_id = int(request.args.get("page", 1256))
        compile_rx(pattern)                         # reject bad patterns before touching the DB
        body, src = cached(f"grep:{page_id}:{pattern}", lambda: grep_article(page_id, pattern))
    except UserError as e:
        return jsonify(error=str(e)), 400
    except ValueError:
        return jsonify(error="bad page id"), 400
    return _json({**body, "cache": src})


def _json(obj):
    return Response(json.dumps(obj, default=str, separators=(",", ":"), ensure_ascii=False),
                    mimetype="application/json")


# ---------------------------------------------------------------- mode 2: the whole wiki at moments
def _asof_one(phrase, date, ids):
    ph = ",".join(["%s"] * len(ids))
    sql = ASOF_SQL.replace("{t}", str(TIMEOUT_S)).replace("{ids}", ph)
    like = "%" + phrase.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    t0 = time.perf_counter()
    try:
        r = rows(sql, (phrase, date + " 00:00:00", *ids, like))
        err = None
    except pymysql.err.OperationalError as e:
        r, err = [], f"stopped after {TIMEOUT_S} s" if e.args and e.args[0] in (1969, 3024) else str(e.args[-1])
    return r, (time.perf_counter() - t0) * 1000, err


def check_phrase(phrase):
    if not phrase or len(phrase) < 3:
        raise UserError("Type at least three characters.")
    if len(phrase) > MAX_PATTERN:
        raise UserError(f"Phrase longer than {MAX_PATTERN} characters.")
    words = re.findall(r"\w+", phrase)
    if not words:
        raise UserError("Type a word or phrase.")
    return words


def grep_wiki(phrase):
    words = check_phrase(phrase)
    ft = '"' + " ".join(words) + '"'
    t0 = time.perf_counter()
    total = rows("""SELECT COUNT(*) n FROM current_article c JOIN viz_timegrep_pages p ON p.page_id=c.page_id
                    WHERE c.lang='fi' AND MATCH(c.title, c.text) AGAINST (%s IN BOOLEAN MODE)""", (ft,))[0]["n"]
    cands = rows(CAND_SQL, (ft, CAP))
    cand_ms = (time.perf_counter() - t0) * 1000
    ids = [c["page_id"] for c in cands]
    snaps = []
    if ids:
        futs = [_pool.submit(_asof_one, phrase, d, ids) for d in SNAP_DATES]
        for d, f in zip(SNAP_DATES, futs):
            r, ms, err = f.result()
            hits = []
            for x in r:
                s = sentence_of(x["around"], re.escape(phrase))
                hits.append({"page_id": x["page_id"], "title": x["title"], "rev": x["rev_id"],
                             "since": _iso(x["row_start"]), "s": s[0] if s else "", "a": s[1] if s else -1,
                             "b": s[2] if s else -1})
            hits.sort(key=lambda h: h["title"])
            snaps.append({"date": d, "n": len(hits), "ms": round(ms), "error": err, "hits": hits})
    # how many of the candidate articles already existed at each date (first edit in `revision`)
    born = rows(f"SELECT page_id, MIN(ts) f FROM revision WHERE page_id IN ({','.join(['%s'] * len(ids))}) "
                "GROUP BY page_id", ids) if ids else []
    for s in snaps:
        lim = dt.datetime.fromisoformat(s["date"])
        s["existing"] = sum(1 for b in born if b["f"] < lim)
    # which articles are new at each snapshot / dropped since the previous one
    prev = {}
    for s in snaps:
        cur = {h["page_id"]: h["title"] for h in s["hits"]}
        for h in s["hits"]:
            h["new"] = h["page_id"] not in prev
        s["added"] = len(cur.keys() - prev.keys())
        gone = prev.keys() - cur.keys()
        s["dropped"] = sorted(prev[k] for k in gone)[:40]
        s["dropped_n"] = len(gone)
        prev = cur
    return {"phrase": phrase, "candidates": len(ids), "candidates_total": total, "cap": CAP,
            "cand_ms": round(cand_ms), "snapshots": snaps, "sql": ASOF_SQL_SHOWN.replace("@phrase", phrase.replace("'", "''"))}


@bp.get("/wiki")
def api_wiki():
    phrase = (request.args.get("q") or "").strip()
    try:
        check_phrase(phrase)
        body, src = cached(f"wiki:{phrase.lower()}", lambda: grep_wiki(phrase))
    except UserError as e:
        return jsonify(error=str(e)), 400
    return _json({**body, "cache": src})


# ---------------------------------------------------------------- article picker
@functools.lru_cache(maxsize=1)
def _pages():
    return rows("SELECT page_id, title, versions FROM viz_timegrep_pages ORDER BY versions DESC")


@bp.get("/pages")
def api_pages():
    q = (request.args.get("q") or "").strip().lower()
    ps = _io.submit(_pages).result()
    if q:
        ps = [p for p in ps if q in p["title"].lower()]
        ps.sort(key=lambda p: (not p["title"].lower().startswith(q), -p["versions"]))
    return jsonify(ps[:12])


def _preload():
    """Warm the in-memory cache with the precomputed presets (each request thread would otherwise
    open its own DB connection first, ~0.7 s over the tunnel)."""
    try:
        for r in rows("SELECT k, body FROM viz_timegrep_cache"):
            with _lock:
                _mem[r["k"]] = json.loads(zlib.decompress(r["body"]))
        _pages()
    except Exception:
        pass


threading.Thread(target=_preload, daemon=True).start()
