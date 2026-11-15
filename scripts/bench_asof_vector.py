"""Benchmark: time-travel vector search on a system-versioned table. Exact search vs the HNSW index
at several mhnsw_ef_search values: recall@10 against exact, duplicate rows, latency.
    cj run -p debug -c 1 -m 1G -t 20m -w -- .venv/bin/python -m scripts.bench_asof_vector"""
import os, statistics, time, requests
from wikitime.db import connect

EMBED = os.environ.get("EMBED_URL", "http://100.73.11.93:8765")
QUESTIONS = ["Mikä on Suomen suhde Natoon?", "Who was the president of Finland from 1956 to 1982?",
             "Miksi Suomen sisällissota syttyi?", "koronarokotukset Suomessa", "Vem var Mannerheim?"]
MOMENTS = ["2006-01-01", "2010-01-01", "2015-01-01", "2020-01-01", "2026-10-01"]
K = 10
vecs = requests.post(f"{EMBED}/embed", json={"texts": QUESTIONS}, timeout=60).json()["vectors"]
import numpy as np
vecs = [np.asarray(v, dtype="<f4").tobytes() for v in vecs]
con = connect(autocommit=True); cur = con.cursor()
SQL = ("SELECT page_id FROM article_vector_history FOR SYSTEM_TIME AS OF TIMESTAMP %s {hint} "
       "ORDER BY VEC_DISTANCE_COSINE(embedding, %s) LIMIT {k}")


def run(hint, t, v, k=K):
    t0 = time.perf_counter(); cur.execute(SQL.format(hint=hint, k=k), (t + " 00:00:00", v))
    ids = [r[0] for r in cur.fetchall()]; return ids, (time.perf_counter() - t0) * 1000


exact = {}
ms = []
for t in MOMENTS:
    for i, v in enumerate(vecs):
        exact[(t, i)], m = run("IGNORE INDEX (embedding)", t, v); ms.append(m)
print(f"exact: median {statistics.median(ms):.0f} ms, max {max(ms):.0f} ms")
for ef in (20, 100, 400, 1000, 2000, 4000):
    cur.execute(f"SET SESSION mhnsw_ef_search = {ef}")
    rec, dup, ms = [], 0, []
    per_t = {}
    for t in MOMENTS:
        for i, v in enumerate(vecs):
            ids, m = run("", t, v); ms.append(m)
            dup += len(ids) - len(set(ids))
            r = len(set(ids) & set(exact[(t, i)])) / K
            rec.append(r); per_t.setdefault(t, []).append(r)
    print(f"index ef={ef:5d}: recall@10 {statistics.mean(rec):.2f} (" +
          ", ".join(f"{t[:4]} {statistics.mean(x):.2f}" for t, x in per_t.items()) +
          f"), duplicate rows {dup}, median {statistics.median(ms):.0f} ms, max {max(ms):.0f} ms")
