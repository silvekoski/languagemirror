"""Biggest Stories: a bar chart race of the largest / most edited articles, 2003-2026.
Frames are precomputed by scripts/build_race.py into viz_race_*; clicking a bar reads the article
exactly as it stood that month from the system-versioned `article` table (FOR SYSTEM_TIME AS OF)."""
import threading
from functools import lru_cache
from flask import Blueprint, jsonify, abort
from app.db import rows
from wikitime.wikitext import clean

bp = Blueprint("race", __name__)

PRECOMPUTE_SQL = """-- scripts/build_race.py: 862k versions -> one row per (article, month), inside MariaDB
SELECT page_id, ym, bytes, title, n, nh FROM (
  SELECT page_id, EXTRACT(YEAR_MONTH FROM ts) AS ym, bytes, title,
         ROW_NUMBER() OVER (PARTITION BY page_id, EXTRACT(YEAR_MONTH FROM ts)
                            ORDER BY ts DESC, rev_id DESC) AS rn,      -- last version of the month
         COUNT(*) OVER (PARTITION BY page_id, EXTRACT(YEAR_MONTH FROM ts)) AS n,
         SUM(LOWER(COALESCE(user,'')) NOT LIKE '%bot')
                  OVER (PARTITION BY page_id, EXTRACT(YEAR_MONTH FROM ts)) AS nh  -- human edits
  FROM revision) v
WHERE rn = 1;
-- then: carry sizes forward month by month, 12-month rolling sum of nh, top 20 -> viz_race_frame"""

ASOF_SQL = """SELECT title, rev_id, user, comment, len, text,
       ROW_START AS valid_from, ROW_END AS valid_to
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s"""


@lru_cache(maxsize=4)
def _frames(mode):
    fr = rows("SELECT ym, rnk, page_id, value, title FROM viz_race_frame WHERE mode=%s ORDER BY ym, rnk", (mode,))
    months = [r["ym"] for r in rows("SELECT ym FROM viz_race_month ORDER BY ym")]
    idx = {ym: i for i, ym in enumerate(months)}
    out = [[] for _ in months]
    for r in fr:
        out[idx[r["ym"]]].append([r["page_id"], r["value"], r["title"]])
    return months, out


@lru_cache(maxsize=1)
def _meta():
    pages = {r["page_id"]: [r["title"], r["cluster_idx"], r["cluster_label"]]
             for r in rows("SELECT page_id, title, cluster_idx, cluster_label FROM viz_race_page")}
    months = rows("SELECT * FROM viz_race_month ORDER BY ym")
    return pages, months


@bp.get("/frames/<mode>")
def frames(mode):
    """All monthly top-20 frames of one ranking: ?mode = bytes | edits."""
    if mode not in ("bytes", "edits"):
        abort(404)
    months, fr = _frames(mode)
    pages, mrows = _meta()
    return jsonify(mode=mode, months=months, frames=fr, pages=pages, month_stats=mrows, sql=PRECOMPUTE_SQL)


def _month_end(ym):
    y, m = divmod(int(ym), 100)
    y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return f"{y:04d}-{m:02d}-01 00:00:00"


_done = {}   # finished answers only: "not loaded yet" may change while the bulk load runs


def _asof(page_id, ym):
    if (page_id, ym) in _done:
        return _done[(page_id, ym)]
    at = _month_end(ym)
    r = rows(ASOF_SQL, (at, page_id))
    rev = rows("""SELECT COUNT(*) versions, COUNT(DISTINCT user) editors, YEAR(MIN(ts)) first_year,
                         CAST(COALESCE(SUM(is_revert), 0) AS INT) reverts,
                         SUBSTRING_INDEX(GROUP_CONCAT(bytes ORDER BY ts DESC, rev_id DESC), ',', 1) + 0 AS bytes
                  FROM revision WHERE page_id=%s AND ts < %s""", (page_id, at))[0]
    out = {"page_id": page_id, "ym": ym, "as_of": at, "history": rev,
           "sql": ASOF_SQL.replace("%s", f"'{at}'", 1).replace("%s", str(page_id), 1)}
    if not r:
        has = rows("SELECT 1 FROM article FOR SYSTEM_TIME ALL WHERE page_id=%s LIMIT 1", (page_id,))
        out["text_status"] = "not_loaded" if not has else "not_yet_written"
        return out
    a = r[0]
    paras, chars = [], 0
    for kind, t in clean(a.pop("text") or ""):
        if kind == "p" and len(t) > 60:
            paras.append(t)
            chars += len(t)
            if chars > 700 or len(paras) >= 2:
                break
    out.update(a, text_status="ok", excerpt=paras,
               valid_from=str(a["valid_from"]), valid_to=str(a["valid_to"]))
    if len(_done) < 2000:
        _done[(page_id, ym)] = out
    return out


def _warm():
    try:
        _meta(); _frames("bytes"); _frames("edits")
    except Exception:
        pass


threading.Thread(target=_warm, daemon=True).start()   # first page load should not wait on the tunnel


@bp.get("/asof/<int:page_id>/<int:ym>")
def asof(page_id, ym):
    """The article as it stood at the end of month ym (YYYYMM), from FOR SYSTEM_TIME AS OF."""
    if not (200301 <= ym <= 202612 and 1 <= ym % 100 <= 12):
        abort(400)
    return jsonify(_asof(page_id, ym))
