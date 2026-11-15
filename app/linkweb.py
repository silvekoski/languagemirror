"""Link Web 3D API. The link graph is precomputed by scripts/build_linkweb.py from wikitext snapshots read
with FOR SYSTEM_TIME AS OF; per-article detail re-reads the article's own version AS OF the chosen year live."""
import functools, threading, time
import pymysql
from flask import Blueprint, jsonify, request
from app.db import rows
from wikitime.db import connect

bp = Blueprint("linkweb", __name__)
SNAPS = [2006, 2010, 2014, 2018, 2022, 2026]
RX = r"(?s).*?\[\[([^\]\[|#\n]{1,200})|(?s).+"

SNAPSHOT_SQL = """-- one query per snapshot, streamed; only link targets leave the server
SELECT page_id,
       REGEXP_REPLACE(text, '(?s).*?\\\\[\\\\[([^\\\\]\\\\[|#\\\\n]{1,200})|(?s).+', '\\\\1\\n') AS links
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2010-01-01 00:00:00';"""

LIVE_SQL = """SELECT rev_id, row_start, user, len,
       REGEXP_REPLACE(text, @link_rx, '\\\\1\\n') AS links
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s"""


def _bit(year):
    return 1 << SNAPS.index(year)


_lock = threading.Lock()

# Flask serves each request on a fresh thread, and app.db keeps one connection per thread, so every click
# would pay a ~0.7 s handshake over the tunnel. The detail endpoint reuses one warm connection instead.
_con_lock = threading.Lock()
_con = None


def _q(sql, params=()):
    global _con
    with _con_lock:
        for attempt in (0, 1):
            try:
                if _con is None:
                    _con = connect(autocommit=True)
                with _con.cursor(pymysql.cursors.DictCursor) as cur:
                    cur.execute(sql, params)
                    return list(cur.fetchall())
            except (pymysql.err.OperationalError, pymysql.err.InterfaceError):
                try:
                    _con.close()
                except Exception:
                    pass
                _con = None
                if attempt:
                    raise


def graph():
    with _lock:                                 # the warm-up thread and early requests share one build
        return _graph()


@functools.lru_cache(maxsize=1)
def _graph():
    t = time.perf_counter()
    nodes = rows("SELECT i, page_id, title, cluster, x, y, z, mask FROM viz_linkweb_nodes ORDER BY i")
    idx = {n["page_id"]: n["i"] for n in nodes}
    edges = rows("""SELECT e.src, e.dst, e.mask FROM viz_linkweb_edges e
                    JOIN viz_linkweb_nodes a ON a.page_id = e.src JOIN viz_linkweb_nodes b ON b.page_id = e.dst""")
    # true in-degree per snapshot, counting links from every article (not only the drawn ones)
    sums = ", ".join(f"SUM(e.mask >> {k} & 1) d{k}" for k in range(len(SNAPS)))
    indeg = {r["dst"]: [int(r[f"d{k}"]) for k in range(len(SNAPS))] for r in rows(
        f"SELECT e.dst, {sums} FROM viz_linkweb_edges e JOIN viz_linkweb_nodes n ON n.page_id = e.dst GROUP BY e.dst")}
    flat = []
    for e in edges:
        flat += (idx[e["src"]], idx[e["dst"]], e["mask"])
    snaps = rows("SELECT year, pages, edges_all FROM viz_linkweb_snapshots ORDER BY year")
    # links added / removed between consecutive snapshots, over ALL resolved links (not only the drawn ones)
    churn = rows("SELECT " + ", ".join(
        f"SUM(((mask >> {k}) & 1) = 1 AND ((mask >> {k - 1}) & 1) = 0) a{k}, "
        f"SUM(((mask >> {k}) & 1) = 0 AND ((mask >> {k - 1}) & 1) = 1) r{k}" for k in range(1, len(SNAPS)))
        + " FROM viz_linkweb_edges")[0]
    for k, s in enumerate(snaps):
        bit = 1 << k
        s["label"] = "today" if s["year"] == SNAPS[-1] else f"1 Jan {s['year']}"
        s["edges_drawn"] = sum(1 for e in edges if e["mask"] & bit)
        s["nodes_drawn"] = sum(1 for n in nodes if n["mask"] & bit)
        top = max(nodes, key=lambda n: indeg.get(n["page_id"], [0] * 6)[k])
        s["top"] = {"title": top["title"], "page_id": top["page_id"], "in": indeg.get(top["page_id"], [0] * 6)[k]}
        if k:
            pbit = 1 << (k - 1)
            s["added"], s["removed"] = int(churn[f"a{k}"]), int(churn[f"r{k}"])
            s["added_drawn"] = sum(1 for e in edges if e["mask"] & bit and not e["mask"] & pbit)
            gain = max(nodes, key=lambda n: (lambda d: d[k] - d[k - 1])(indeg.get(n["page_id"], [0] * 6)))
            gd = indeg.get(gain["page_id"], [0] * 6)
            s["gainer"] = {"title": gain["title"], "page_id": gain["page_id"], "from": gd[k - 1], "to": gd[k]}
    clusters = {r["cluster"]: r["label"] for r in rows("SELECT cluster, label FROM viz_linkweb_clusters")}
    return {
        "snaps": snaps,
        "nodes": {"page_id": [n["page_id"] for n in nodes], "title": [n["title"] for n in nodes],
                  "cluster": [n["cluster"] for n in nodes], "mask": [n["mask"] for n in nodes],
                  "xyz": [round(v, 2) for n in nodes for v in (n["x"], n["y"], n["z"])],
                  "indeg": [indeg.get(n["page_id"], [0] * 6) for n in nodes]},
        "edges": flat,
        "clusters": clusters,
        "sql": SNAPSHOT_SQL,
        "build_ms": round((time.perf_counter() - t) * 1000),
    }


@bp.get("/graph")
def graph_api():
    return jsonify(graph())


@functools.lru_cache(maxsize=1)
def _all_titles():
    """page_id -> latest title of every article in the set (one query, cached)."""
    return {r["page_id"]: r["title"] for r in rows(
        """SELECT r.page_id, r.title FROM revision r
           JOIN (SELECT page_id, MAX(ts) ts FROM revision GROUP BY page_id) m USING (page_id, ts)""")}


def _titles(ids):
    t = _all_titles()
    return {i: t.get(i) for i in ids}


def _warm():
    try:
        graph()
        _all_titles()
        _q("SELECT 1")
    except Exception as e:                      # the DB may be unreachable at startup; first request retries
        print("linkweb warmup failed:", e)


threading.Thread(target=_warm, daemon=True).start()


@bp.get("/node/<int:page_id>")
def node(page_id):
    y = request.args.get("year", str(SNAPS[-1]))
    year = int(y) if y.isdigit() else None
    if year not in SNAPS:
        return jsonify(error="year must be one of %s" % SNAPS), 400
    k = SNAPS.index(year)
    bit = 1 << k
    lk = _q("""SELECT 'o' dir, dst id, mask, first_year FROM viz_linkweb_edges WHERE src=%s
               UNION ALL SELECT 'i', src, mask, first_year FROM viz_linkweb_edges WHERE dst=%s""", (page_id, page_id))
    out_l = [r for r in lk if r["dir"] == "o"]
    in_l = [r for r in lk if r["dir"] == "i"]
    names = _titles(list({r["id"] for r in out_l + in_l} | {page_id}))

    def pack(lst):
        now = [r for r in lst if r["mask"] & bit]
        gone = [r for r in lst if k and r["mask"] & (bit >> 1) and not r["mask"] & bit]
        res = [{"page_id": r["id"], "title": names.get(r["id"], f"#{r['id']}"), "first": r["first_year"],
                "new": bool(k and not r["mask"] & (bit >> 1))} for r in now]
        res.sort(key=lambda r: (not r["new"], r["title"] or ""))
        return res, [{"page_id": r["id"], "title": names.get(r["id"], f"#{r['id']}")} for r in gone]

    outs, outs_gone = pack(out_l)
    ins, ins_gone = pack(in_l)
    # live time travel: the version of this article that was current at the snapshot
    t = time.perf_counter()
    if year == SNAPS[-1]:
        v = _q("""SELECT rev_id, row_start, user, len, REGEXP_REPLACE(text, %s, '\\\\1\\n') links
                    FROM article WHERE page_id=%s""", (RX, page_id))
    else:
        v = _q("""SELECT rev_id, row_start, user, len, REGEXP_REPLACE(text, %s, '\\\\1\\n') links
                    FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE page_id=%s""",
                 (RX, f"{year}-01-01 00:00:00", page_id))
    ms = round((time.perf_counter() - t) * 1000, 1)
    version = None
    if v:
        r = v[0]
        raw = [l for l in (r["links"] or "").split("\n") if l.strip()]
        version = {"rev_id": r["rev_id"], "ts": r["row_start"].isoformat(sep=" ", timespec="minutes"),
                   "user": r["user"], "len": r["len"], "wikilinks": len(raw)}
    first = _history(page_id)
    return jsonify(page_id=page_id, title=names.get(page_id), year=year, out=outs, inn=ins,
                   out_gone=outs_gone, in_gone=ins_gone, version=version, ms=ms,
                   created=first["t"].isoformat()[:10] if first["t"] else None, versions=first["n"],
                   sql=LIVE_SQL % (f"'{year}-01-01 00:00:00'" if year != SNAPS[-1] else "NOW()", page_id))


@functools.lru_cache(maxsize=4096)
def _history(page_id):
    return _q("SELECT MIN(ts) t, COUNT(*) n FROM revision WHERE page_id=%s", (page_id,))[0]


@bp.get("/search")
def search():
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])
    q = q[:100].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return jsonify(_q("""SELECT i, page_id, title FROM viz_linkweb_nodes WHERE title LIKE %s
                         ORDER BY title LIKE %s DESC, LENGTH(title) LIMIT 12""", (f"%{q}%", f"{q}%")))
