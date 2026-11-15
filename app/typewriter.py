"""Typewriter API: replay how an article's lead section was written, version by version.

Every version comes from the system-versioned `article` table (FOR SYSTEM_TIME ALL, ordered by
row_start = Wikipedia's real edit time). The lead is the wikitext before the first heading,
cut in SQL with SUBSTRING_INDEX so only the lead crosses the network, then cleaned to plain text.
Per-version metadata (who, when, words added/removed in the lead) is precomputed for a picker set
into viz_typewriter_version by scripts/build_typewriter.py; any other article with text is computed
live (and cached)."""
import gzip
import html
import json
import re
import queue
import threading
import time
from difflib import SequenceMatcher
from functools import lru_cache

from flask import Blueprint, Response, jsonify, request
import pymysql
from wikitime.db import connect
from wikitime.wikitext import clean

bp = Blueprint("typewriter", __name__)

# Flask's threaded server runs every request on a fresh thread, so app.db's per-thread connection would
# reconnect (~0.7 s over the tunnel) on each request. Keep a small pool of live connections instead.
_pool = queue.LifoQueue()


def rows(sql, params=()):
    for attempt in (0, 1):
        try:
            con = _pool.get_nowait()
        except queue.Empty:
            con = connect(autocommit=True)
        try:
            with con.cursor() as cur:
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description] if cur.description else []
                out = [dict(zip(cols, r)) for r in cur.fetchall()] if cols else []
            _pool.put(con)
            return out
        except (pymysql.err.OperationalError, pymysql.err.InterfaceError):
            try:
                con.close()
            except Exception:
                pass
            if attempt:
                raise

LEAD_CHARS = 2500
CHUNK = 50

# The query the replay is built on (shown in the page's "The SQL" box).
VERSIONS_SQL = """SELECT a.rev_id, a.row_start AS ts, a.user, a.anonymous, a.minor, a.comment, a.len,
       r.delta, r.is_revert,
       IF(CRC32(lead) <=> LAG(CRC32(lead)) OVER w, NULL, lead) AS lead_if_changed
FROM (SELECT rev_id, row_start, user, anonymous, minor, comment, len,
             SUBSTRING_INDEX(text, '\\n==', 1) AS lead          -- wikitext before the first heading
      FROM article FOR SYSTEM_TIME ALL                         -- every version, not just today's
      WHERE page_id = %s) a
LEFT JOIN revision r ON r.rev_id = a.rev_id
WINDOW w AS (ORDER BY a.row_start)
ORDER BY a.row_start"""

LEADS_SQL = """SELECT row_start AS ts, SUBSTRING_INDEX(text, '\\n==', 1) AS lead
FROM article FOR SYSTEM_TIME ALL
WHERE page_id = %s AND row_start IN ({})"""


def lead_text(wikitext):
    """Readable lead: paragraphs/list items before the first heading, ~LEAD_CHARS characters."""
    out, n = [], 0
    for kind, t in clean(wikitext or ""):
        if kind == "h":
            break
        t = html.unescape(t).strip()
        if not t:
            continue
        if n + len(t) > LEAD_CHARS:
            cut = t[:max(0, LEAD_CHARS - n)].rsplit(" ", 1)[0]
            if cut:
                out.append(cut + " …")
            break
        out.append(t)
        n += len(t) + 2
    return "\n\n".join(out)


def tokens(text):
    return re.findall(r"\n\n|[^\s]+", text)


_BOT = re.compile(r"(bot\d*(~fiwiki)?$|\(bot\)$)", re.I)


def is_bot(user):
    return bool(user) and bool(_BOT.search(user))


def _iso(dt):
    return dt.isoformat(sep=" ") if dt else None


def compute_versions(page_id):
    """All versions of one article with lead-diff stats. Returns (title, versions)."""
    raw = rows(VERSIONS_SQL, (page_id,))
    if not raw:
        return None, []
    title = rows("SELECT title FROM article WHERE page_id=%s", (page_id,))
    title = title[0]["title"] if title else None
    out, prev_tok, prev_text = [], [], None
    for i, r in enumerate(raw):
        changed, add, rem = 0, 0, 0
        if r["lead_if_changed"] is not None:
            text = lead_text(r["lead_if_changed"])
            if text != prev_text:
                tok = tokens(text)
                for tag, i1, i2, j1, j2 in SequenceMatcher(None, prev_tok, tok, autojunk=False).get_opcodes():
                    if tag in ("replace", "delete"):
                        rem += sum(1 for t in prev_tok[i1:i2] if t != "\n\n")
                    if tag in ("replace", "insert"):
                        add += sum(1 for t in tok[j1:j2] if t != "\n\n")
                changed, prev_tok, prev_text = 1, tok, text
        out.append(dict(seq=i, rev_id=r["rev_id"], ts=r["ts"], user=r["user"] or "",
                        anonymous=int(r["anonymous"] or 0), bot=int(is_bot(r["user"])),
                        minor=int(r["minor"] or 0), is_revert=int(r["is_revert"] or 0),
                        delta=int(r["delta"] or 0), len=int(r["len"] or 0),
                        comment=(r["comment"] or "")[:500], lead_changed=changed,
                        w_add=add, w_del=rem,
                        lead_words=sum(1 for t in prev_tok if t != "\n\n")))
    return title, out


def cache_hits(maxsize):
    """Like lru_cache, but never remembers a miss (None or empty): the bulk text load is still running,
    so an article without text now may have it later."""
    def deco(fn):
        memo, lock = {}, threading.Lock()

        def wrapper(*a):
            if a in memo:
                return memo[a]
            out = fn(*a)
            if out and (not isinstance(out, tuple) or out[1]):
                with lock:
                    if len(memo) >= maxsize:
                        memo.pop(next(iter(memo)))
                    memo[a] = out
            return out
        return wrapper
    return deco


# Whole precomputed table, loaded once in the background (one ~7 MB read instead of one per request).
_ALL = {}            # page_id -> (title, versions)
_TEXT_IDS = [0.0, frozenset()]   # (loaded_at, page_ids with stored text); refreshed while the bulk load runs
_TITLES = []         # [(lower title, page_id, title)] for search


def _load_all():
    titles = {r["page_id"]: r["title"] for r in rows("SELECT page_id, title FROM viz_typewriter_article")}
    by = {}
    for r in rows("""SELECT page_id, seq, rev_id, ts, user, anonymous, bot, minor, is_revert, delta, len, comment,
                     lead_changed, w_add, w_del, lead_words FROM viz_typewriter_version ORDER BY page_id, seq"""):
        by.setdefault(r.pop("page_id"), []).append(r)
    for pid, v in by.items():
        _ALL[pid] = (titles.get(pid), v)


def text_ids():
    if time.time() - _TEXT_IDS[0] > 300:
        _TEXT_IDS[:] = [time.time(), frozenset(r["page_id"] for r in
                        rows("SELECT DISTINCT page_id FROM article FOR SYSTEM_TIME ALL"))]
    return _TEXT_IDS[1]


@cache_hits(64)
def versions(page_id):
    if page_id in _ALL:
        title, v = _ALL[page_id]
        return title, v, True
    if _TEXT_IDS[1] and page_id not in text_ids():
        return None, [], False
    v = rows("""SELECT seq, rev_id, ts, user, anonymous, bot, minor, is_revert, delta, len, comment,
                lead_changed, w_add, w_del, lead_words FROM viz_typewriter_version
                WHERE page_id=%s ORDER BY seq""", (page_id,))
    if v:
        t = rows("SELECT title FROM viz_typewriter_article WHERE page_id=%s", (page_id,))
        return (t[0]["title"] if t else None), v, True
    title, v = compute_versions(page_id)
    return title, v, False


@bp.get("/articles")
def articles():
    return jsonify(_articles())


@lru_cache(maxsize=1)
def _articles():
    r = rows("""SELECT page_id, title, versions, lead_changes, reverts, editors, famous,
                YEAR(first_ts) y0, YEAR(last_ts) y1 FROM viz_typewriter_article
                ORDER BY famous DESC, versions DESC""")
    return r


@bp.get("/search")
def search_route():
    return jsonify(search(request.args.get("q", "").strip()[:80]))


def search(q):
    if len(q) < 2:
        return []
    if _TITLES:   # in memory: titles of all Finnish articles, filtered to those with stored text
        ql, ids = q.lower(), text_ids()
        # rank: precomputed (heavily edited) articles, then title prefix, then word prefix, then shorter
        hit = [(pid not in _ALL, not lt.startswith(ql), (" " + ql) not in lt, len(t), t, pid)
               for lt, pid, t in _TITLES if ql in lt and pid in ids]
        return [dict(page_id=h[5], title=h[4]) for h in sorted(hit)[:12]]
    esc = q.replace("=", "==").replace("%", "=%").replace("_", "=_")
    found = rows("""SELECT page_id, title FROM current_article WHERE lang='fi' AND title LIKE %s ESCAPE '='
                    ORDER BY (title LIKE %s ESCAPE '=') DESC, CHAR_LENGTH(title) LIMIT 40""",
                 ("%" + esc + "%", esc + "%"))
    if not found:
        return []
    ids = {r["page_id"] for r in rows("SELECT DISTINCT page_id FROM article WHERE page_id IN (%s)"
                                      % ",".join(str(int(r["page_id"])) for r in found))}
    return [r for r in found if r["page_id"] in ids][:12]


@bp.get("/meta/<int:page_id>")
def meta(page_id):
    body = _meta_body(page_id)
    if body is None:
        return jsonify(error="No stored text for this article"), 404
    return _gz_bytes(body)


@cache_hits(128)
def _meta_body(page_id):
    """gzipped JSON of one article's version table, cached (~20-40 kB each)."""
    title, v, pre = versions(page_id)
    if not v:
        return None
    changed = [x["seq"] for x in v if x["lead_changed"]]
    cols = ["seq", "rev_id", "ts", "user", "anonymous", "bot", "minor", "is_revert", "delta", "len",
            "comment", "lead_changed", "w_add", "w_del", "lead_words"]
    data = [[_iso(x["ts"])[:19] if c == "ts" else x[c] for c in cols] for x in v]
    body = dict(page_id=page_id, title=title, precomputed=pre, chunk=CHUNK,
                cols=cols, rows=data, changed=changed, sql=VERSIONS_SQL.replace("%s", str(page_id)))
    return _gzip(body)


def _gzip(obj):
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str).encode(), 6)


def _gz_bytes(gz):
    if "gzip" not in request.headers.get("Accept-Encoding", ""):
        return Response(gzip.decompress(gz), mimetype="application/json")
    r = Response(gz, mimetype="application/json")
    r.headers["Content-Encoding"] = "gzip"
    return r


@cache_hits(1024)
def _chunk(page_id, k):
    """gzipped JSON of lead changes k*CHUNK..k*CHUNK+CHUNK-1 (tokens + word opcodes), cached."""
    return _gzip(dict(chunk=k, leads=_chunk_leads(page_id, k)))


def _chunk_leads(page_id, k):
    title, v, _ = versions(page_id)
    changed = [x for x in v if x["lead_changed"]]
    part = changed[k * CHUNK:(k + 1) * CHUNK]
    if not part:
        return []
    prev = changed[k * CHUNK - 1] if k else None
    want = ([prev] if prev else []) + part
    leads = {r["ts"]: r["lead"] for r in rows(LEADS_SQL.format(",".join(["%s"] * len(want))),
                                               (page_id, *[x["ts"] for x in want]))}
    prev_tok = tokens(lead_text(leads.get(prev["ts"]))) if prev else []
    out = []
    for x in part:
        tok = tokens(lead_text(leads.get(x["ts"])))
        ops = [[tag[0], i1, i2, j1, j2] for tag, i1, i2, j1, j2
               in SequenceMatcher(None, prev_tok, tok, autojunk=False).get_opcodes()]
        out.append(dict(seq=x["seq"], tokens=tok, ops=ops))
        prev_tok = tok
    return out


@bp.get("/leads/<int:page_id>")
def leads(page_id):
    try:
        k = max(0, int(request.args.get("chunk", 0)))
    except ValueError:
        return jsonify(error="chunk must be an integer"), 400
    if not versions(page_id)[1]:
        return jsonify(chunk=k, leads=[])
    return _gz_bytes(_chunk(page_id, k))


def default_seq(v):
    """Same choice as the page: the biggest genuine rewrite (most words both removed and added)."""
    rw = [x for x in v[1:] if x["lead_changed"] and not x["is_revert"]]
    return max(rw, key=lambda x: min(x["w_add"], x["w_del"]))["seq"] if rw else len(v) - 1


def _warm_page(pid):
    _meta_body(pid)
    _, v, _ = versions(pid)
    changed = [x["seq"] for x in v if x["lead_changed"]]
    if not changed:
        return
    s = default_seq(v)
    ci = max(i for i, c in enumerate(changed) if c <= s) if changed[0] <= s else 0
    k = ci // CHUNK
    _chunk(pid, k)
    if ci % CHUNK == 0 and k:
        _chunk(pid, k - 1)
    _chunk(pid, 0)


def _warm():
    """Warm the caches so every picker article opens instantly: the default article first, then the
    whole precomputed table, the title list for search, and each picker article's first chunks."""
    for step in (lambda: _articles(), lambda: _warm_page(1256), _load_all, text_ids,
                 lambda: _TITLES.extend(sorted((r["title"].lower(), r["page_id"], r["title"]) for r in
                                        rows("SELECT page_id, title FROM current_article WHERE lang='fi'")))):
        try:
            step()
        except Exception:
            pass
    for a in _articles():
        try:
            _warm_page(a["page_id"])
        except Exception:
            pass


threading.Thread(target=_warm, daemon=True).start()
