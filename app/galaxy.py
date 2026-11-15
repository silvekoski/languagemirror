"""3D Knowledge Galaxy API. The star map itself is baked to web/data/galaxy.json by scripts/build_galaxy.py;
live queries (nearest neighbours by meaning) run against MariaDB's vector index."""
import time
from flask import Blueprint, jsonify, request
from app.db import rows

bp = Blueprint("galaxy", __name__)

NEIGHBORS_SQL = """SELECT s.lang, s.page_id, a.title, s.distance, g.x, g.y, g.z
FROM (SELECT lang, page_id, VEC_DISTANCE_COSINE(embedding, %s) AS distance
      FROM article_vector ORDER BY distance LIMIT %s) s
JOIN current_article a USING (lang, page_id)
LEFT JOIN galaxy_point g USING (lang, page_id)
ORDER BY s.distance"""


@bp.get("/neighbors/<lang>/<int:page_id>")
def neighbors(lang, page_id):
    k = min(int(request.args.get("k", 12)), 50)
    v = rows("SELECT embedding FROM article_vector WHERE lang=%s AND page_id=%s", (lang, page_id))
    if not v:
        return jsonify(error="no vector"), 404
    t = time.perf_counter()
    found = rows(NEIGHBORS_SQL, (v[0]["embedding"], k + 1))
    ms = (time.perf_counter() - t) * 1000
    found = [r for r in found if not (r["lang"] == lang and r["page_id"] == page_id)][:k]
    return jsonify(neighbors=found, ms=round(ms, 1),
                   sql=NEIGHBORS_SQL.replace("%s", "@v", 1).replace("%s", str(k + 1)))


@bp.get("/article/<lang>/<int:page_id>")
def article(lang, page_id):
    r = rows("""SELECT lang, page_id, title, url, wikidata_id, LEFT(text, 600) AS intro
                FROM current_article WHERE lang=%s AND page_id=%s""", (lang, page_id))
    if not r:
        return jsonify(error="not found"), 404
    a = r[0]
    a["categories"] = [c["category"] for c in rows(
        "SELECT category FROM article_category WHERE lang=%s AND page_id=%s LIMIT 8", (lang, page_id))]
    if lang == "fi":
        a["history"] = rows("""SELECT COUNT(*) versions, SUM(is_revert) reverts, MIN(ts) first_edit,
                                      COUNT(DISTINCT user) editors, MAX(has_text) has_text
                               FROM revision WHERE page_id=%s""", (page_id,))[0]
        a["yearly"] = rows("SELECT YEAR(ts) y, COUNT(*) n FROM revision WHERE page_id=%s GROUP BY y", (page_id,))
    return jsonify(a)
