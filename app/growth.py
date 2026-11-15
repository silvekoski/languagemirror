"""Growing Tree API: the category tree under 'Suomen historia' filling up, 2003 -> 2026.

Per-quarter category sizes and per-article year-end sizes are baked into viz_growth_* by
scripts/build_growth.py (from the metadata of all 862k versions in `revision`). The article drill-down
asks the system-versioned `article` table what the article said at the end of the chosen year."""
import datetime as dt
import functools
import gzip
import json
import threading

from flask import Blueprint, Response, request
from app.db import rows
from wikitime.wikitext import clean
from scripts.build_growth import tree_payload

bp = Blueprint("growth", __name__)
Y0, Y1 = 2003, 2026
DATA_END = "2026-10-01 23:59:59"

TOP_SQL = """SELECT cp.page_id, t.title, ay.bytes, ay.rev_id, ay.edits, ay.edits_y,
       ay.bytes - COALESCE(prev.bytes, 0) AS grew, prev.page_id IS NULL AS is_new,
       cp.share, cp.direct, YEAR(t.first_ts) AS born
FROM viz_growth_cat_page cp                       -- every article in the category's subtree
JOIN viz_growth_article_year ay   ON ay.y = %s AND ay.page_id = cp.page_id
LEFT JOIN viz_growth_article_year prev ON prev.y = %s AND prev.page_id = cp.page_id
JOIN viz_growth_article t ON t.page_id = cp.page_id
WHERE cp.cat_id = %s
ORDER BY {order} DESC LIMIT %s"""

SNAP_SQL = """SELECT rev_id, user, len, LEFT(text, 20000) AS text, row_start
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s"""


def _gz(obj):
    raw = json.dumps(obj, separators=(",", ":"), default=str).encode()
    if "gzip" in request.headers.get("Accept-Encoding", ""):
        return Response(gzip.compress(raw, 6), mimetype="application/json",
                        headers={"Content-Encoding": "gzip", "Cache-Control": "max-age=300"})
    return Response(raw, mimetype="application/json")


def _year_arg():
    y = request.args.get("year", Y1, type=int)     # junk -> default instead of a 500
    return max(Y0, min(Y1, y))


def _year_end(y):
    return DATA_END if y >= Y1 else f"{y}-12-31 23:59:59"


_tree_lock = threading.Lock()
_tree_cache = []


def _tree_bytes():
    """(raw, gzip) of the whole tree. Read from the pre-built gzip blob (one ~0.5 MB row) when it exists;
    otherwise assembled from viz_growth_* (several MB over the tunnel, ~5 s)."""
    with _tree_lock:
        if not _tree_cache:
            try:
                blob = rows("SELECT v FROM viz_growth_blob WHERE k='tree'")
            except Exception:
                blob = []
            if blob:
                gz = bytes(blob[0]["v"])
                raw = gzip.decompress(gz)
            else:
                raw = json.dumps(tree_payload(rows), separators=(",", ":"), default=str).encode()
                gz = gzip.compress(raw, 6)
            _tree_cache.append((raw, gz))
        return _tree_cache[0]


@bp.get("/tree")
def tree():
    raw, gz = _tree_bytes()
    if "gzip" in request.headers.get("Accept-Encoding", ""):
        return Response(gz, mimetype="application/json",
                        headers={"Content-Encoding": "gzip", "Cache-Control": "max-age=300"})
    return Response(raw, mimetype="application/json")


@functools.lru_cache(maxsize=512)
def _category(cat_id, y):
    c = rows("SELECT cat_id, name, parent_id, depth, parents, n_direct FROM viz_growth_cat WHERE cat_id=%s",
             (cat_id,))
    if not c:
        return None
    c = c[0]
    c["parents"] = c["parents"].split("\t") if c["parents"] else []
    agg = rows("""SELECT COUNT(ay.page_id) AS articles, SUM(ay.bytes) AS bytes, SUM(ay.edits) AS edits,
                         SUM(ay.edits_y) AS edits_y, COUNT(*) AS total
                  FROM viz_growth_cat_page cp LEFT JOIN viz_growth_article_year ay ON ay.y=%s AND ay.page_id=cp.page_id
                  WHERE cp.cat_id=%s""", (y, cat_id))[0]
    total = agg["total"]
    both = rows("(" + TOP_SQL.format(order="ay.bytes").replace("SELECT ", "SELECT 'b' AS lst, ", 1) + ") UNION ALL ("
                + TOP_SQL.format(order="grew").replace("SELECT ", "SELECT 'g' AS lst, ", 1) + ")",
                (y, y - 1, cat_id, 12, y, y - 1, cat_id, 6))
    for r in both:
        r["grew"] = int(r["grew"])
    biggest = [r for r in both if r["lst"] == "b"]
    grew = [r for r in both if r["lst"] == "g" and r["grew"] > 0]
    for lst in (biggest, grew):
        for r in lst:
            del r["lst"]
            r["share"] = round(float(r["share"]), 3)
            r["is_new"] = bool(r["is_new"])
    return {"cat": c, "year": y, "as_of": _year_end(y),
            "articles": int(agg["articles"] or 0), "articles_today": int(total),
            "bytes": int(agg["bytes"] or 0), "edits": int(agg["edits"] or 0), "edits_y": int(agg["edits_y"] or 0),
            "biggest": biggest, "grew": grew,
            "sql": TOP_SQL.format(order="ay.bytes").replace("%s", str(y), 1).replace("%s", str(y - 1), 1)
                          .replace("%s", str(cat_id), 1).replace("%s", "12", 1)}


@bp.get("/category/<int:cat_id>")
def category(cat_id):
    y = _year_arg()
    out = _category(cat_id, y)
    if out is None:
        return _gz({"error": "no such category"}), 404
    return _gz(out)


def _intro(text, limit=700):
    out, n = [], 0
    for kind, t in clean(text or ""):
        if kind != "p" or len(t) < 40:
            continue
        out.append(t)
        n += len(t)
        if n > limit:
            break
    s = " ".join(out)
    return s[:limit].rsplit(" ", 1)[0] + "…" if len(s) > limit else s


@functools.lru_cache(maxsize=256)
def _article(page_id, y):
    a = rows("SELECT page_id, title, first_ts, n_cats FROM viz_growth_article WHERE page_id=%s", (page_id,))
    if not a:
        return None
    a = a[0]
    a["series"] = rows("SELECT y, bytes, rev_id, edits_y FROM viz_growth_article_year WHERE page_id=%s "
                       "ORDER BY y", (page_id,))
    a["cats"] = rows("""SELECT c.cat_id, c.name FROM article_category ac JOIN viz_growth_cat c ON c.name = ac.category
                        WHERE ac.lang='fi' AND ac.page_id=%s ORDER BY c.name""", (page_id,))
    a["year"], a["as_of"] = y, _year_end(y)
    snaps = rows("SELECT 't' AS w, s.* FROM (" + SNAP_SQL + ") s UNION ALL SELECT 'n', s.* FROM (" + SNAP_SQL + ") s",
                 (_year_end(y), page_id, DATA_END, page_id))
    has = bool(snaps) or bool(rows("SELECT 1 FROM article FOR SYSTEM_TIME ALL WHERE page_id=%s LIMIT 1", (page_id,)))
    a["has_text"] = has
    if has:
        then = [r for r in snaps if r["w"] == "t"]
        now = [r for r in snaps if r["w"] == "n"]
        a["then"] = ({"rev_id": then[0]["rev_id"], "user": then[0]["user"], "len": then[0]["len"],
                      "since": str(then[0]["row_start"])[:19], "intro": _intro(then[0]["text"])} if then else None)
        a["now"] = ({"rev_id": now[0]["rev_id"], "len": now[0]["len"], "intro": _intro(now[0]["text"])}
                    if now else None)
        a["sql"] = SNAP_SQL.replace("%s", f"'{_year_end(y)}'", 1).replace("%s", str(page_id), 1)
    return a


@bp.get("/article/<int:page_id>")
def article(page_id):
    y = _year_arg()
    out = _article(page_id, y)
    if out is None:
        return _gz({"error": "no such article"}), 404
    return _gz(out)


@functools.lru_cache(maxsize=1)
def _search_index():
    """All 19.7k titles with today's size and categories: one query, then searched in memory."""
    out = []
    for r in rows("""SELECT t.page_id, t.title, ay.bytes, GROUP_CONCAT(c.cat_id) AS cats
                     FROM viz_growth_article t JOIN viz_growth_article_year ay ON ay.y=%s AND ay.page_id=t.page_id
                     LEFT JOIN article_category ac ON ac.lang='fi' AND ac.page_id=t.page_id
                     LEFT JOIN viz_growth_cat c ON c.name = ac.category
                     GROUP BY t.page_id""", (Y1,)):
        cats = sorted(int(x) for x in r["cats"].split(",")) if r["cats"] else []
        out.append((r["title"].casefold(), {"page_id": r["page_id"], "title": r["title"],
                                             "bytes": int(r["bytes"]), "cats": cats}))
    return out


@bp.get("/search")
def search():
    q = request.args.get("q", "").strip().casefold()
    if len(q) < 2:
        return _gz({"articles": []})
    hits = [(not t.startswith(q), -h["bytes"], h) for t, h in _search_index() if q in t]
    hits.sort(key=lambda x: x[:2])
    return _gz({"articles": [h for _, _, h in hits[:8]]})


def _warm():
    try:
        _tree_bytes()
        _search_index()
    except Exception:          # the first request will simply build it
        pass


threading.Thread(target=_warm, daemon=True).start()
