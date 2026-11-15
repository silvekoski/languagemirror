"""Edit Wars API: who undoes whom. Revert events are precomputed for all 19,742 articles into viz_editwars_*
by scripts/build_editwars.py (window functions over `revision`); what a revert actually removed is read live
from the system-versioned `article` table with FOR SYSTEM_TIME AS OF, one microsecond before and at the revert."""
import datetime as dt, difflib, functools, json, re, threading, time
from flask import Blueprint, Response, request
from app.db import rows
from wikitime.wikitext import clean

bp = Blueprint("editwars", __name__)


def jsonify(obj=None, **kw):
    """Compact JSON (the dev server pretty-prints jsonify, which triples big article payloads)."""
    return Response(json.dumps(kw if obj is None else obj, separators=(",", ":"), ensure_ascii=False, default=str),
                    mimetype="application/json")
CLASSES = ("war", "dispute", "vandal", "bot", "self")

DERIVE_SQL = """-- 1. number every version per article, and find the last earlier version with the same text
SELECT page_id, rev_id, ts, user,
       ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY ts, rev_id)       AS seq,
       LAG(rev_id)  OVER (PARTITION BY page_id, sha1 ORDER BY ts, rev_id) AS same_prev
FROM revision;                                   -- 862,076 versions -> tmp_seq

-- 2. a revert (is_revert) restores same_prev; every version in between was undone
SELECT e.rev_id AS revert, r.user AS reverted, COUNT(*) AS versions, MIN(r.ts) AS first_undone
FROM tmp_seq e
JOIN tmp_seq p ON p.rev_id = e.same_prev                          -- the restored version
JOIN tmp_seq r ON r.page_id = e.page_id AND r.seq > p.seq AND r.seq < e.seq
WHERE e.is_revert = 1
GROUP BY e.rev_id, r.user;                       -- -> viz_editwars_edges"""

DIFF_SQL = """-- the article one microsecond before the revert ...
SELECT rev_id, user, text FROM article
FOR SYSTEM_TIME AS OF TIMESTAMP '{before}' FORCE INDEX (start_key)
WHERE page_id = {pid};
-- ... and right after it (= the restored text)
SELECT rev_id, user, text FROM article
FOR SYSTEM_TIME AS OF TIMESTAMP '{at}' FORCE INDEX (start_key)
WHERE page_id = {pid};"""

SORTS = {"war": "n_war DESC, war_pairs DESC", "pairs": "war_pairs DESC, n_war DESC",
         "dispute": "n_dispute DESC", "vandal": "n_vandal DESC", "reverts": "n_reverts DESC",
         "rate": "versions >= 100 DESC, n_reverts / versions DESC", "recent": "last_ts DESC"}


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


_TEXT_SEEN, _TEXT_MISS = set(), {}   # the bulk text load is still running: a miss is re-checked after 5 min


def _has_text(pids):
    now = time.time()
    ask = [p for p in pids if p not in _TEXT_SEEN and now - _TEXT_MISS.get(p, 0) > 300]
    if ask:
        marks = ",".join(["%s"] * len(ask))
        found = {r["page_id"] for r in rows(
            f"SELECT DISTINCT page_id FROM article FOR SYSTEM_TIME ALL WHERE page_id IN ({marks})", tuple(ask))}
        _TEXT_SEEN.update(found)
        _TEXT_MISS.update((p, now) for p in ask if p not in found)
    return {p for p in pids if p in _TEXT_SEEN}


@functools.lru_cache(maxsize=1)
def _overview():
    tot = {r["cls"]: int(r["n"]) for r in rows("SELECT cls, COUNT(*) n FROM viz_editwars_events GROUP BY cls")}
    monthly = rows("SELECT month, cls, n FROM viz_editwars_monthly ORDER BY month")
    edits = {r["month"]: r for r in rows("SELECT month, edits, anon FROM viz_editwars_edits_monthly")}
    months = sorted(set(edits) | {r["month"] for r in monthly})
    by = {m: dict.fromkeys(CLASSES, 0) for m in months}
    for r in monthly:
        by[r["month"]][r["cls"]] = int(r["n"])
    series = [dict(m=m.strftime("%Y-%m"), edits=int(edits[m]["edits"]) if m in edits else 0, **by[m]) for m in months]
    # fiercest rivalries: registered pairs who reverted each other in the same article
    pairs = rows("""SELECT page_id, a, b, SUM(n) n, SUM(ab) ab, SUM(ba) ba, MIN(first) first, MAX(last) last FROM (
                      SELECT page_id, LEAST(reverter, reverted) a, GREATEST(reverter, reverted) b, COUNT(*) n,
                             SUM(reverter < reverted) ab, SUM(reverter > reverted) ba, MIN(ts) first, MAX(ts) last
                      FROM viz_editwars_edges WHERE cls = 'war' GROUP BY 1, 2, 3, reverter) x
                    GROUP BY page_id, a, b ORDER BY n DESC, last DESC LIMIT 12""")
    titles = {r["page_id"]: r["title"] for r in rows(
        "SELECT page_id, title FROM viz_editwars_articles WHERE page_id IN (%s)" % ",".join(
            str(int(p["page_id"])) for p in pairs))} if pairs else {}
    for p in pairs:
        p.update(title=titles.get(p["page_id"]), n=int(p["n"]), ab=int(p["ab"]), ba=int(p["ba"]),
                 first=_iso(p["first"]), last=_iso(p["last"]))
    ttr = {r["cls"]: r["med"] for r in rows(
        "SELECT DISTINCT cls, MEDIAN(ttr_s) OVER (PARTITION BY cls) med FROM viz_editwars_events")}
    top = rows("SELECT page_id, title FROM viz_editwars_articles ORDER BY n_war DESC, war_pairs DESC LIMIT 1")[0]
    agg = rows("""SELECT COUNT(*) articles, SUM(n_war > 0) war_articles, SUM(war_pairs) war_pairs
                  FROM viz_editwars_articles""")[0]
    return dict(totals=tot, series=series, rivalries=pairs, median_ttr_s={k: float(v) for k, v in ttr.items()},
                default_page=top, articles=int(agg["articles"]), war_articles=int(agg["war_articles"]),
                war_pairs=int(agg["war_pairs"]), versions=int(sum(r["edits"] for r in edits.values())),
                sql=DERIVE_SQL)


@bp.get("/overview")
def overview():
    return jsonify(_overview())


YEAR_SQL = """SELECT a.page_id, a.title, a.versions, y.n_reverts, y.n_war, y.n_dispute, y.n_vandal, y.n_bot, y.n_self,
       COALESCE(p.war_pairs, 0) war_pairs, a.warriors, y.first_ts, y.last_ts, a.spark
FROM (SELECT page_id, COUNT(*) n_reverts, SUM(cls='war') n_war, SUM(cls='dispute') n_dispute,
             SUM(cls='vandal') n_vandal, SUM(cls='bot') n_bot, SUM(cls='self') n_self, MIN(ts) first_ts, MAX(ts) last_ts
      FROM viz_editwars_events WHERE ts >= %s AND ts < %s GROUP BY page_id) y
JOIN viz_editwars_articles a USING (page_id)
LEFT JOIN (SELECT page_id, COUNT(DISTINCT LEAST(reverter, reverted), GREATEST(reverter, reverted)) war_pairs
           FROM viz_editwars_edges WHERE cls = 'war' AND ts >= %s AND ts < %s GROUP BY page_id) p USING (page_id)"""


@functools.lru_cache(maxsize=256)
def _articles(sort, q, limit, year=None):
    where, params = "WHERE n_reverts > 0", []
    q = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    src = "viz_editwars_articles"
    if year:
        src = f"({YEAR_SQL}) t"
        params += [f"{year}-01-01", f"{year + 1}-01-01"] * 2
    if q:
        where += " AND title LIKE %s"
        params.append(f"%{q}%")
    out = rows(f"""SELECT page_id, title, versions, n_reverts, n_war, n_dispute, n_vandal, n_bot, n_self, war_pairs,
                          warriors, first_ts, last_ts, spark FROM {src} {where}
                   ORDER BY {SORTS[sort]}, page_id LIMIT {int(limit)}""", tuple(params))
    for r in out:
        r["spark"] = json.loads(r["spark"])
        r["first_ts"], r["last_ts"] = _iso(r["first_ts"]), _iso(r["last_ts"])
        for k in ("n_reverts", "n_war", "n_dispute", "n_vandal", "n_bot", "n_self", "war_pairs"):
            r[k] = int(r[k])
    return out


@bp.get("/articles")
def articles():
    sort = request.args.get("sort", "war")
    sort = sort if sort in SORTS else "war"
    q = (request.args.get("q") or "").strip()[:80]
    limit = max(1, min(request.args.get("limit", 40, type=int) or 40, 200))
    year = request.args.get("year", type=int)
    year = year if year and 2003 <= year <= 2026 else None
    out = [dict(r) for r in _articles(sort, q, limit, year)]
    has = _has_text([r["page_id"] for r in out])
    for r in out:
        r["has_text"] = r["page_id"] in has
    return jsonify(articles=out, sort=sort, year=year)


def _kind(user, anon):
    return "anon" if anon else ("bot" if (user or "").lower().endswith("bot") else "reg")


@functools.lru_cache(maxsize=128)
def _article(pid):
    meta = rows("SELECT * FROM viz_editwars_articles WHERE page_id=%s", (pid,))
    if not meta:
        return None
    meta = meta[0]
    meta["spark"] = json.loads(meta["spark"])
    meta["first_ts"], meta["last_ts"] = _iso(meta["first_ts"]), _iso(meta["last_ts"])
    t = time.perf_counter()
    events = rows("""SELECT rev_id, ts, reverter, reverter_kind, restored_rev_id, undone_rev_id, n_versions, n_editors,
                            reverted, reverted_kind, ttr_s, cls, comment, delta, undone_comment
                     FROM viz_editwars_events WHERE page_id=%s ORDER BY ts""", (pid,))
    edges = rows("""SELECT rev_id, ts, reverter, reverted, n_versions n, ttr_s, cls
                    FROM viz_editwars_edges WHERE page_id=%s ORDER BY ts""", (pid,))
    eds = rows("SELECT user, anon, edits, first_ts, last_ts FROM viz_editwars_nodes WHERE page_id=%s", (pid,))
    ms = (time.perf_counter() - t) * 1000
    nodes = [dict(id=r["user"], kind=_kind(r["user"], r["anon"]), edits=int(r["edits"]),
                  first=_iso(r["first_ts"]), last=_iso(r["last_ts"])) for r in eds]
    for e in events:
        e["ts"] = _iso(e["ts"])
        e["undone_comment"] = (e["undone_comment"] or "")[:160]
    for e in edges:
        e["ts"] = _iso(e["ts"])
    return dict(article=meta, events=events, edges=edges, nodes=nodes, ms=round(ms, 1),
                sql=f"""SELECT * FROM viz_editwars_events WHERE page_id = {pid} ORDER BY ts;   -- revert events
SELECT * FROM viz_editwars_edges  WHERE page_id = {pid} ORDER BY ts;   -- who undid whom
SELECT user, edits, anon FROM viz_editwars_nodes            -- node sizes: their edits here
WHERE page_id = {pid};   -- precomputed: COUNT(*) FROM revision GROUP BY page_id, user""")


@bp.get("/article/<int:pid>")
def article(pid):
    a = _article(pid)
    if not a:
        return jsonify(error="no reverts recorded for this article"), 404
    a = dict(a, article=dict(a["article"], has_text=bool(_has_text([pid]))))
    return jsonify(a), 200


def _blocks(text):
    return [f"{'## ' if k == 'h' else '• ' if k == 'li' else ''}{t}" for k, t in clean(text) if t.strip()]


def _words(a, b):
    """Word-level diff of two paragraphs -> list of [op, text] with op in = - +."""
    wa, wb = re.findall(r"\S+\s*", a), re.findall(r"\S+\s*", b)
    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, wa, wb, autojunk=False).get_opcodes():
        if op == "equal":
            out.append(["=", "".join(wa[i1:i2])])
        else:
            if i2 > i1:
                out.append(["-", "".join(wa[i1:i2])])
            if j2 > j1:
                out.append(["+", "".join(wb[j1:j2])])
    return out


def _raw_lines(text):
    return [l for l in text.split("\n") if l.strip()]


_DIFFS = {}


def _diff(rev_id):
    if rev_id in _DIFFS:
        return _DIFFS[rev_id]
    d = _diff_read(rev_id)
    if d and d.get("text") and len(_DIFFS) < 512:   # 'no text yet' answers are not cached: the load is running
        _DIFFS[rev_id] = d
    return d


def _diff_read(rev_id):
    e = rows("SELECT * FROM viz_editwars_events WHERE rev_id=%s", (rev_id,))
    if not e:
        return None
    e = e[0]
    at = e["ts"]
    before = at - dt.timedelta(microseconds=1)
    # FORCE INDEX(start_key): (page_id, row_start) plus the primary key's row_end lets InnoDB test both period
    # bounds inside the index, so only the one matching version's compressed text is read (cold: ~50x fewer pages)
    q = ("SELECT rev_id, user, text, row_start FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s FORCE INDEX (start_key) "
         "WHERE page_id=%s")
    t = time.perf_counter()
    b = rows(q, (before, e["page_id"]))
    a = rows(q, (at, e["page_id"]))
    ms = (time.perf_counter() - t) * 1000
    revs = rows("""SELECT rev_id, ts, user, anonymous, delta, LEFT(comment, 200) comment FROM revision
                   WHERE page_id=%s AND ts > (SELECT ts FROM revision WHERE rev_id=%s) AND ts <= %s ORDER BY ts""",
                (e["page_id"], e["restored_rev_id"], at))
    out = dict(rev_id=rev_id, page_id=e["page_id"], ts=_iso(at), cls=e["cls"], reverter=e["reverter"],
               restored_rev_id=e["restored_rev_id"], ms=round(ms, 1),
               versions=[dict(r, ts=_iso(r["ts"]), kind=_kind(r["user"], r["anonymous"])) for r in revs],
               sql=DIFF_SQL.format(before=before.strftime("%Y-%m-%d %H:%M:%S.%f"),
                                   at=at.strftime("%Y-%m-%d %H:%M:%S.%f"), pid=e["page_id"]))
    if not (a and b) or a[0]["rev_id"] != rev_id:
        out["text"] = False
        return out
    out.update(text=True, before_rev=b[0]["rev_id"], before_user=b[0]["user"], after_rev=a[0]["rev_id"])
    ta, tb = b[0]["text"], a[0]["text"]   # ta: before the revert (the undone state), tb: restored
    xa, xb = _blocks(ta), _blocks(tb)
    if xa == xb:                           # the fight was over markup (links, templates, refs): diff raw lines
        xa, xb, out["raw"] = _raw_lines(ta), _raw_lines(tb), True
    hunks = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, xa, xb, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        rem, add = xa[i1:i2], xb[j1:j2]
        h = dict(ctx=xa[i1 - 1][:220] if i1 > 0 else None, parts=[])
        for k in range(max(len(rem), len(add))):
            r_, a_ = (rem[k] if k < len(rem) else None), (add[k] if k < len(add) else None)
            if r_ is not None and a_ is not None and difflib.SequenceMatcher(None, r_, a_).quick_ratio() > 0.4:
                h["parts"].append(dict(words=_words(r_, a_)))
            else:
                if r_ is not None:
                    h["parts"].append(dict(removed=r_[:1500]))
                if a_ is not None:
                    h["parts"].append(dict(added=a_[:1500]))
        hunks.append(h)
        if len(hunks) >= 12:
            break
    out["hunks"] = hunks
    out["bytes"] = [len(ta.encode()), len(tb.encode())]
    return out


@bp.get("/diff/<int:rev_id>")
def diff(rev_id):
    d = _diff(rev_id)
    return (jsonify(d), 200) if d else (jsonify(error="not a revert event"), 404)


def _warm():
    """Fill the caches for the landing view in the background, so the first visitor doesn't wait on cold pages."""
    try:
        ov = _overview()
        _articles("war", "", 80, None)
        _article(int(ov["default_page"]["page_id"]))
    except Exception as e:  # noqa: BLE001 - warming is best effort
        print("editwars warm-up failed:", e)


threading.Thread(target=_warm, daemon=True).start()
