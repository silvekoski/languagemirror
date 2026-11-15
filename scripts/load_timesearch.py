"""Time-travel search, step 2: load data/timesearch/snapshots.parquet (from embed_snapshots.py on chili)
into article_vector_history: a SYSTEM-VERSIONED table with a VECTOR INDEX. Each snapshot is written with
its real Wikipedia time (system_versioning_insert_history): row_start = when that version was saved,
row_end = when the next sampled snapshot was saved; the latest is current.
    uv run python -m scripts.load_timesearch [--index/--no-index]"""
import argparse, time
from collections import defaultdict
from datetime import timedelta
import numpy as np, pyarrow.parquet as pq
from wikitime.db import connect

ap = argparse.ArgumentParser()
ap.add_argument("--no-index", action="store_true")
args = ap.parse_args()
t0 = time.time()
con = connect()
cur = con.cursor()
cur.execute(f"""CREATE TABLE IF NOT EXISTS article_vector_history (
  page_id   INT UNSIGNED NOT NULL,
  rev_id    INT UNSIGNED NOT NULL,          -- the Wikipedia version this vector was made from
  title     VARCHAR(255) NOT NULL,
  embedding VECTOR(1024) NOT NULL,          -- bge-m3 of title + cleaned text (first 2048 tokens)
  row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end   TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id)
  {'' if args.no_index else ', VECTOR INDEX (embedding) M=16 DISTANCE=cosine'}
) WITH SYSTEM VERSIONING""")
cur.execute("SET system_versioning_insert_history = 1")
cur.execute("SELECT COUNT(*) FROM article_vector_history FOR SYSTEM_TIME ALL")
if cur.fetchone()[0]:
    raise SystemExit("article_vector_history already has rows; DROP it first to reload")

tb = pq.read_table("data/timesearch/snapshots.parquet")
E = tb.column("emb").combine_chunks().values.to_numpy(zero_copy_only=False).reshape(-1, 1024).astype("<f4")
meta = tb.drop_columns(["emb"]).to_pylist()
by_page = defaultdict(list)
for i, m in enumerate(meta):
    by_page[m["page_id"]].append(i)
print(f"{len(meta)} snapshots of {len(by_page)} articles ({time.time() - t0:.0f} s)", flush=True)

H = "INSERT INTO article_vector_history (page_id, rev_id, title, embedding, row_start, row_end) VALUES (%s,%s,%s,%s,%s,%s)"
C = "INSERT INTO article_vector_history (page_id, rev_id, title, embedding, row_start) VALUES (%s,%s,%s,%s,%s)"
hist, curr, n = [], [], 0
for p, idx in by_page.items():
    idx.sort(key=lambda i: meta[i]["ts"])
    times = [meta[i]["ts"].replace(tzinfo=None) for i in idx]
    for k in range(1, len(times)):
        if times[k] <= times[k - 1]:
            times[k] = times[k - 1] + timedelta(microseconds=1)
    for k, i in enumerate(idx):
        m = meta[i]
        row = (p, m["rev_id"], m["title"], E[i].tobytes(), times[k])
        (hist.append(row + (times[k + 1],)) if k + 1 < len(idx) else curr.append(row))
    if len(hist) + len(curr) >= 2000:
        cur.executemany(H, hist); cur.executemany(C, curr); con.commit()
        n += len(hist) + len(curr); hist, curr = [], []
        print(f"  {n} rows ({time.time() - t0:.0f} s)", flush=True)
cur.executemany(H, hist); cur.executemany(C, curr); con.commit()
cur.execute("SELECT COUNT(*) FROM article_vector_history FOR SYSTEM_TIME ALL")
print(f"done: {cur.fetchone()[0]} rows ({time.time() - t0:.0f} s)")
