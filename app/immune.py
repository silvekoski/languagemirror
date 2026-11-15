"""Immune System API: how fast Finnish Wikipedia undoes bad versions. Aggregates come from viz_immune_*
(scripts/build_immune.py); the "what readers saw" view reads the two versions straight from the
system-versioned `article` table with FOR SYSTEM_TIME AS OF."""
import datetime, difflib, functools, json, re, threading
from flask import Blueprint, jsonify, request
import queue
import pymysql
from wikitime.db import connect
from wikitime.wikitext import clean

# app.db keeps one connection per thread, but the dev server starts a fresh thread per request and a
# fresh connection to chili costs ~0.7-3 s. A small pool shared across request threads avoids that.
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
                out = [] if cur.description is None else \
                    [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
            _pool.put(con)
            return out
        except (pymysql.err.OperationalError, pymysql.err.InterfaceError):
            try:
                con.close()
            except Exception:
                pass
            if attempt:
                raise

bp = Blueprint("immune", __name__)

BUILD_SQL = """-- 1. number every version per article and find the last earlier version with the same text
CREATE TEMPORARY TABLE seq AS
SELECT page_id, rev_id, ts, user, is_revert, bytes,
       ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY ts, rev_id)        AS seq,
       LAG(rev_id)  OVER (PARTITION BY page_id, sha1 ORDER BY ts, rev_id) AS same_prev
FROM revision;

-- 2. every version strictly between the restored one and the revert was undone
INSERT INTO viz_immune_bad
SELECT r.rev_id, r.page_id, r.ts, <kind>, e.rev_id, e.ts,
       TIMESTAMPDIFF(SECOND, r.ts, e.ts)                AS lifetime_s,
       HOUR(CONVERT_TZ(r.ts, 'UTC', 'Europe/Helsinki')) AS h_edit,
       HOUR(CONVERT_TZ(e.ts, 'UTC', 'Europe/Helsinki')) AS h_revert
FROM seq e
JOIN seq p ON p.rev_id = e.same_prev                    -- the restored version
JOIN seq r ON r.page_id = e.page_id AND r.seq > p.seq AND r.seq < e.seq
WHERE e.is_revert AND e.bytes > 0 AND e.seq - p.seq - 1 BETWEEN 1 AND 50
  AND NOT (r.user <=> e.user);                          -- self-reverts are not healing"""

ASOF_SQL = """SELECT 'bad' AS v, rev_id, user, comment, text
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE page_id = %s
UNION ALL
SELECT 'before', rev_id, user, comment, text
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE page_id = %s"""


@functools.lru_cache(maxsize=1)
def _overview():
    meta = json.loads(rows("SELECT v FROM viz_immune_meta WHERE k='meta'")[0]["v"])
    years = rows("SELECT * FROM viz_immune_year WHERE year >= 2004 ORDER BY year")
    bins = rows("SELECT year, bin, n FROM viz_immune_year_bin WHERE year >= 2004")
    hist = rows("SELECT bin, kind, n FROM viz_immune_hist")
    hours = rows("SELECT * FROM viz_immune_hour ORDER BY hour")
    arts = rows("""SELECT page_id, title, versions, n_bad, n_reverts, bad_anon, median_s, peak_year, peak_n, years
                   FROM viz_immune_article ORDER BY n_bad DESC LIMIT 40""")
    ids = [a["page_id"] for a in arts]
    with_text = {r["page_id"] for r in rows(
        f"SELECT DISTINCT page_id FROM article FOR SYSTEM_TIME ALL WHERE page_id IN ({','.join(['%s'] * len(ids))})",
        ids)} if ids else set()
    for a in arts:
        a["years"] = json.loads(a["years"])
        a["has_text"] = a["page_id"] in with_text
    longest = rows("""SELECT b.rev_id, b.page_id, b.ts, b.kind, b.lifetime_s, b.revert_rev_id, r.title
                      FROM (SELECT * FROM viz_immune_bad ORDER BY lifetime_s DESC LIMIT 8) b
                      JOIN revision r ON r.rev_id = b.rev_id ORDER BY b.lifetime_s DESC""")
    for y in years:
        y["mean_log"] = round(y["mean_log"], 3)
    return dict(meta=meta, years=years, bins=bins, hist=hist, hours=hours, articles=arts, longest=longest,
                sql=BUILD_SQL)


def _safe(f):
    try:
        f()
    except Exception:
        pass


_ov_lock = threading.Lock()


def _warm():
    """Warm the overview and the top articles' histories so first clicks answer instantly."""
    with _ov_lock:
        _safe(_overview)
    try:
        arts = _overview()["articles"]
    except Exception:
        return
    for a in sorted(arts, key=lambda a: not a["has_text"])[:20]:   # the default detail view first
        _safe(lambda: _article(a["page_id"]))


threading.Thread(target=_warm, daemon=True).start()   # warm the caches at startup


@bp.get("/overview")
def overview():
    with _ov_lock:          # a request arriving during the startup warm waits for it instead of redoing it
        return jsonify(_overview())


@functools.lru_cache(maxsize=256)
def _article(page_id):
    bad = rows("""SELECT b.rev_id, b.ts, b.kind, b.lifetime_s, b.revert_rev_id, b.revert_ts,
                         r.user, r.delta, LEFT(r.comment, 120) AS comment, LEFT(v.comment, 120) AS revert_comment,
                         v.user AS reverter
                  FROM viz_immune_bad b JOIN revision r ON r.rev_id = b.rev_id
                  JOIN revision v ON v.rev_id = b.revert_rev_id
                  WHERE b.page_id = %s ORDER BY b.ts""", (page_id,))
    t = rows("""SELECT (SELECT title FROM revision WHERE page_id=%s ORDER BY ts DESC LIMIT 1) AS title,
                       EXISTS (SELECT 1 FROM article FOR SYSTEM_TIME ALL WHERE page_id=%s) AS has_text""",
             (page_id, page_id))[0]   # one round trip: the DB is ~100 ms away
    return dict(page_id=page_id, title=t["title"] or str(page_id), bad=bad, has_text=bool(t["has_text"]))


@bp.get("/article/<int:page_id>")
def article(page_id):
    return jsonify(_article(page_id))


def _words(wikitext):
    return " ".join(t for _k, t in clean(wikitext or "")).split()


@functools.lru_cache(maxsize=512)
def _version(rev_id):
    b = rows("SELECT rev_id, page_id, ts, kind, lifetime_s, revert_rev_id FROM viz_immune_bad WHERE rev_id=%s",
             (rev_id,))
    if not b:
        return None
    b = b[0]
    just_before = b["ts"] - datetime.timedelta(microseconds=1)
    got = {r["v"]: r for r in rows(ASOF_SQL, (b["ts"], b["page_id"], just_before, b["page_id"]))}
    out = dict(rev_id=rev_id, page_id=b["page_id"], ts=b["ts"], lifetime_s=b["lifetime_s"], kind=b["kind"],
               sql=ASOF_SQL.replace("%s", f"'{b['ts']}'", 1).replace("%s", str(b["page_id"]), 1)
                   .replace("%s", f"'{just_before}'", 1).replace("%s", str(b["page_id"]), 1))
    bad, before = got.get("bad"), got.get("before")
    if not bad or bad["rev_id"] != rev_id:
        out["available"] = False      # text of this article not loaded (only ~17.4k small + 50 famous articles)
        return out
    out["available"] = True
    a, c = _words(before["text"]) if before else [], _words(bad["text"])
    hunks = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, c, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        hunks.append(dict(ctx_before=" ".join(a[max(0, i1 - 8):i1]), removed=" ".join(a[i1:i2])[:600],
                          added=" ".join(c[j1:j2])[:600], ctx_after=" ".join(a[i2:i2 + 8])))
        if len(hunks) >= 6:
            break
    out.update(hunks=hunks, words_before=len(a), words_bad=len(c),
               blanked=len(c) < 0.5 * len(a) if a else False, user=bad["user"], comment=bad["comment"])
    return out


@bp.get("/version/<int:rev_id>")
def version(rev_id):
    v = _version(rev_id)
    return (jsonify(v), 200) if v else (jsonify(error="not a reverted version"), 404)
