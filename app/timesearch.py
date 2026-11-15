"""Time Machine Search: semantic search over Wikipedia *as it stood at any moment*.

article_vector_history is a system-versioned table of bge-m3 vectors, one row per yearly snapshot
of every article, written with Wikipedia's real edit times. One statement does the time travel and
the vector search together:

    SELECT ... FROM article_vector_history FOR SYSTEM_TIME AS OF TIMESTAMP '2012-01-01'
    ORDER BY VEC_DISTANCE_COSINE(embedding, @q) LIMIT 10

Questions are embedded with bge-m3 by scripts/embed_server.py (EMBED_URL, a job on chili).
Without it, "like:<page_id>" queries use an article's own vector as the question.
"""
import functools, os, re, time
import numpy as np, requests
from flask import Blueprint, jsonify, request
from app.db import rows
from wikitime.wikitext import clean

bp = Blueprint("timesearch", __name__)
EMBED_URL = os.environ.get("EMBED_URL", "http://127.0.0.1:8765")
YEARS = list(range(2004, 2027))

# Exact search on purpose (IGNORE INDEX). Measured (scripts/bench_asof_vector.py, 5 questions x 5 dates):
# the HNSW index spans every version of every year, so a FOR SYSTEM_TIME AS OF filter discards most of
# its candidates: recall@10 was 0.47 at the default ef_search (0.91 at 1000, 0.98 at 4000, with
# multi-second outliers) and it can even repeat rows. Exact search over the 170k vectors is 100%
# correct at ~115 ms on the server.
SEARCH_SQL = """SELECT page_id, title, rev_id, row_start, distance
FROM (SELECT page_id, title, rev_id, row_start,
             VEC_DISTANCE_COSINE(embedding, %s) AS distance
      FROM article_vector_history FOR SYSTEM_TIME AS OF TIMESTAMP %s IGNORE INDEX (embedding)
      ORDER BY distance LIMIT %s) s
ORDER BY distance"""

# the same search over today's rows only (no FOR SYSTEM_TIME clause = current versions)
NOW_SQL = """SELECT page_id FROM (SELECT page_id, VEC_DISTANCE_COSINE(embedding, %s) AS distance
      FROM article_vector_history IGNORE INDEX (embedding) ORDER BY distance LIMIT %s) s"""


@functools.lru_cache(maxsize=512)
def embed(q):
    r = requests.post(f"{EMBED_URL}/embed", json={"texts": [q]}, timeout=20)
    r.raise_for_status()
    return np.asarray(r.json()["vectors"][0], dtype="<f4").tobytes()


def query_vector(q):
    """'like:<page_id>' -> that article's current vector; anything else -> bge-m3 of the text."""
    m = re.fullmatch(r"like:(\d+)", q.strip())
    if m:
        v = rows("SELECT embedding, title FROM article_vector_history WHERE page_id=%s", (int(m.group(1)),))
        if not v:
            raise LookupError("no such article")
        return v[0]["embedding"], f"like “{v[0]['title']}”"
    return embed(q.strip()), None


def moment(t):
    t = (t or "2026-10-01").replace("T", " ")
    if re.fullmatch(r"\d{4}", t):
        t += "-01-01"
    return t + {10: " 00:00:00", 16: ":00"}.get(len(t), "")


@functools.lru_cache(maxsize=4096)
def lead_as_of(page_id, t, rev_id=None):
    """The first paragraphs of the article as it read at moment t: from snapshot_text when the matched
    snapshot is there (one key read), else from the system-versioned article table (FOR SYSTEM_TIME AS OF)."""
    paras = None
    if rev_id:
        try:
            r = rows("SELECT text FROM snapshot_text WHERE rev_id=%s", (rev_id,))
            if r:
                paras = [x for x in r[0]["text"].split("\n\n") if not x.startswith("## ") and len(x) > 40]
        except Exception:
            paras = None
    if paras is None:
        r = rows("""SELECT rev_id, text FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE page_id=%s""", (t, page_id))
        if not r:
            return None
        paras = [x for k, x in clean(r[0]["text"]) if k == "p" and len(x) > 40]
    lead = " ".join(paras[:2])
    return lead[:520] + ("…" if len(lead) > 520 else "")


def search_as_of(vec, t, k):
    """Top-k articles as Wikipedia stood at moment t: list of dicts with page_id, title, rev_id, row_start, distance."""
    return rows(SEARCH_SQL, (vec, t, k))


def search(vec, t, k):
    t0 = time.perf_counter()
    found = rows(SEARCH_SQL, (vec, t, k))
    ms = (time.perf_counter() - t0) * 1000
    return found, ms


@bp.get("/search")
def api_search():
    q, k = request.args.get("q", ""), min(int(request.args.get("k", 10)), 30)
    t = moment(request.args.get("t"))
    if not q.strip():
        return jsonify(error="empty query"), 400
    try:
        vec, label = query_vector(q)
    except LookupError as e:
        return jsonify(error=str(e)), 404
    except requests.RequestException:
        return jsonify(error="embedder offline", hint="start scripts/embed_server.py or use like:<page_id>"), 503
    found, ms = search(vec, t, k)
    now = {r["page_id"] for r in rows(NOW_SQL, (vec, k))}
    for r in found:
        r["snippet"] = lead_as_of(r["page_id"], t, r["rev_id"])
        r["version_of"] = r.pop("row_start")
        r["also_today"] = r["page_id"] in now
    return jsonify(moment=t, label=label, ms=round(ms, 1), results=found,
                   sql=SEARCH_SQL.replace("%s", "@question", 1).replace("%s", f"'{t}'", 1).replace("%s", str(k)))


@functools.lru_cache(maxsize=128)
def drift_for(q, k):
    vec, label = query_vector(q)
    series, timing = {}, []
    for y in YEARS + ["now"]:
        t = moment("2026-10-01" if y == "now" else str(y))
        found, ms = search(vec, t, k)
        timing.append(round(ms, 1))
        for rank, r in enumerate(found, 1):
            s = series.setdefault(r["page_id"], {"page_id": r["page_id"], "title": r["title"], "ranks": {}})
            s["ranks"][str(y)] = rank
            s["title"] = r["title"]
    return {"label": label, "years": [str(y) for y in YEARS] + ["now"], "series": list(series.values()),
            "ms_median": sorted(timing)[len(timing) // 2]}


@bp.get("/drift")
def api_drift():
    q, k = request.args.get("q", ""), min(int(request.args.get("k", 8)), 15)
    if not q.strip():
        return jsonify(error="empty query"), 400
    try:
        return jsonify(drift_for(q.strip(), k))
    except LookupError as e:
        return jsonify(error=str(e)), 404
    except requests.RequestException:
        return jsonify(error="embedder offline"), 503


@bp.get("/status")
def api_status():
    try:
        ok = requests.get(EMBED_URL, timeout=2).ok
    except requests.RequestException:
        ok = False
    n = rows("SELECT COUNT(*) n FROM article_vector_history FOR SYSTEM_TIME ALL")[0]["n"]
    return jsonify(embedder=ok, snapshots=n)


@bp.get("/titles")
def api_titles():
    q = request.args.get("q", "").strip()
    if len(q) < 2:
        return jsonify([])
    return jsonify(rows("""SELECT page_id, title FROM article_vector_history
                           WHERE title LIKE %s ORDER BY LENGTH(title) LIMIT 10""", (f"%{q}%",)))
