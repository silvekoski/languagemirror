"""Time-travel search, step 1 (GPU, chili): embed yearly snapshots of every article with bge-m3.

    cj run -g -c 8 -m 24G -t 2h -- .venv-gpu/bin/python -m scripts.embed_snapshots

For every article in dataset M, take the version that was current on 1 January of each year
2004..2026 plus the latest version; deduplicate by text (sha1). Embed title + cleaned text
(first --max-tokens tokens) with BAAI/bge-m3 (dense, normalised) — the same model as dataset S's
vectors (there via Ollama); a check at the start compares the two on S's own texts.

Output data/timesearch/snapshots.parquet: page_id, rev_id, title, ts (this version's save time),
next_ts (save time of the next sampled snapshot, null for the latest), sha1, emb (1024 x float16).
In MariaDB each row becomes one system-versioned vector row with row_start=ts, row_end=next_ts,
so FOR SYSTEM_TIME AS OF T + VEC_DISTANCE_COSINE searches the encyclopedia as it stood at T
(each article as of its last sampled version, at most a year stale).
"""
import argparse, glob, os, time
from datetime import datetime, timezone
import numpy as np, pyarrow as pa, pyarrow.parquet as pq
import torch
from sentence_transformers import SentenceTransformer
from wikitime.wikitext import clean

ap = argparse.ArgumentParser()
ap.add_argument("--max-tokens", type=int, default=2048)
ap.add_argument("--batch", type=int, default=32)
ap.add_argument("--limit-files", type=int, default=0)
args = ap.parse_args()
t0 = time.time()

model = SentenceTransformer("BAAI/bge-m3", device="cuda", model_kwargs={"torch_dtype": torch.float16})
model.max_seq_length = args.max_tokens
print(f"model loaded {time.time() - t0:.0f} s, {torch.cuda.get_device_name()}", flush=True)


def to_text(title, wikitext):
    body = "\n".join(t for _, t in clean(wikitext or ""))
    return f"{title}\n\n{body}"


# --- consistency check against dataset S (Ollama bge-m3, 8192 tokens) ----------------------------
s_art = pq.read_table("data/s/articles-fi.parquet", columns=["page_id", "title", "text"]).to_pylist()[:300]
s_vec = pq.read_table("data/s/vectors-bge-m3-fi.parquet", columns=["page_id", "embedding"])
vmap = dict(zip(s_vec.column("page_id").to_pylist(),
                s_vec.column("embedding").combine_chunks().values.to_numpy().reshape(-1, 1024)))
model.max_seq_length = 8192
mine = model.encode([f"{a['title']}\n\n{a['text']}" for a in s_art], batch_size=8, normalize_embeddings=True)
ref = np.stack([vmap[a["page_id"]] for a in s_art]); ref /= np.linalg.norm(ref, axis=1, keepdims=True)
cos = (mine * ref).sum(1)
print(f"S check: cosine(ours, dataset S) mean {cos.mean():.4f} min {cos.min():.4f} (title+text format guess)", flush=True)
model.max_seq_length = args.max_tokens

# --- pick the snapshots --------------------------------------------------------------------------
BOUNDS = [datetime(y, 1, 1, tzinfo=timezone.utc) for y in range(2004, 2027)]
files = sorted(glob.glob("data/m/versions-*.parquet"))
if args.limit_files:
    files = files[:args.limit_files]
rows, texts = [], []
for f in files:
    pf = pq.ParquetFile(f)
    cur, buf = None, []

    def flush(vs):
        vs.sort(key=lambda r: (r["timestamp"], r["rev_id"]))
        picked, j = [], 0
        for b in BOUNDS:
            while j + 1 < len(vs) and vs[j + 1]["timestamp"] < b:
                j += 1
            if vs[j]["timestamp"] < b:
                picked.append(j)
        picked.append(len(vs) - 1)
        picked = sorted(set(picked))
        # consecutive picks with identical text collapse into one row
        keep = [k for n, k in enumerate(picked) if n == 0 or vs[k]["sha1"] != vs[picked[n - 1]]["sha1"]]
        for n, k in enumerate(keep):
            v = vs[k]
            nxt = vs[keep[n + 1]]["timestamp"] if n + 1 < len(keep) else None
            rows.append((v["page_id"], v["rev_id"], v["title"], v["timestamp"], nxt, v["sha1"]))
            texts.append(to_text(v["title"], v["text"]))

    for g in range(pf.metadata.num_row_groups):
        for r in pf.read_row_group(g, columns=["page_id", "rev_id", "title", "timestamp", "sha1", "text"]).to_pylist():
            if r["page_id"] != cur:
                if buf:
                    flush(buf)
                cur, buf = r["page_id"], []
            buf.append(r)
    if buf:
        flush(buf)
    print(f"{f}: {len(rows)} snapshots so far ({time.time() - t0:.0f} s)", flush=True)

# --- embed, longest first (less padding), deduplicated by text ------------------------------------
uniq = {}
for i, r in enumerate(rows):
    uniq.setdefault(r[5], i)
order = sorted(uniq.values(), key=lambda i: -len(texts[i]))
print(f"{len(rows)} snapshots, {len(order)} distinct texts to embed", flush=True)
emb = {}
for s in range(0, len(order), 2048):
    chunk = order[s:s + 2048]
    e = model.encode([texts[i] for i in chunk], batch_size=args.batch, normalize_embeddings=True,
                     convert_to_numpy=True).astype(np.float16)
    for i, v in zip(chunk, e):
        emb[rows[i][5]] = v
    print(f"  embedded {min(s + 2048, len(order))}/{len(order)} ({time.time() - t0:.0f} s)", flush=True)

os.makedirs("data/timesearch", exist_ok=True)
E = np.stack([emb[r[5]] for r in rows])
tab = pa.table({
    "page_id": [r[0] for r in rows], "rev_id": [r[1] for r in rows], "title": [r[2] for r in rows],
    "ts": [r[3] for r in rows], "next_ts": [r[4] for r in rows], "sha1": [r[5] for r in rows],
    "emb": pa.FixedSizeListArray.from_arrays(pa.array(E.ravel(), pa.float16()), 1024),
})
pq.write_table(tab, "data/timesearch/snapshots.parquet", compression="zstd")
print(f"done: {len(rows)} rows, {os.path.getsize('data/timesearch/snapshots.parquet') / 1e6:.0f} MB, {time.time() - t0:.0f} s")
