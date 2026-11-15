"""3D map of the articles: UMAP of the bge-m3 vectors (cosine) + clusters. Runs on chili:
    cj run -c 16 -m 8G -t 30m -- uv run --with umap-learn python -m scripts.project_3d
Writes data/galaxy/coords.parquet: lang, page_id, x, y, z, cluster (HDBSCAN on a 10-D UMAP, -1 = noise)."""
import glob, os, time
import numpy as np, pyarrow as pa, pyarrow.parquet as pq
import umap
from sklearn.cluster import HDBSCAN

t = time.time()
tabs = [pq.read_table(f) for f in sorted(glob.glob("data/s/vectors-bge-m3-*.parquet"))]
tab = pa.concat_tables([x.select(["lang", "page_id", "embedding"]) for x in tabs])
X = tab.column("embedding").combine_chunks().values.to_numpy().reshape(-1, 1024).astype(np.float32)
X /= np.linalg.norm(X, axis=1, keepdims=True)
print(X.shape, f"{time.time() - t:.0f} s", flush=True)

xyz = umap.UMAP(n_components=3, n_neighbors=30, min_dist=0.15, metric="cosine", random_state=42,
                n_jobs=os.cpu_count()).fit_transform(X)
print("umap 3d", f"{time.time() - t:.0f} s", flush=True)
z10 = umap.UMAP(n_components=10, n_neighbors=30, min_dist=0.0, metric="cosine", random_state=42,
                n_jobs=os.cpu_count()).fit_transform(X)
labels = HDBSCAN(min_cluster_size=40, min_samples=10).fit_predict(z10)
print("clusters", labels.max() + 1, "noise", (labels < 0).mean().round(3), f"{time.time() - t:.0f} s", flush=True)

xyz = (xyz - xyz.mean(0)) / xyz.std(0)
os.makedirs("data/galaxy", exist_ok=True)
pq.write_table(pa.table({"lang": tab.column("lang"), "page_id": tab.column("page_id"),
                         "x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2], "cluster": labels}),
               "data/galaxy/coords.parquet")
print("done", f"{time.time() - t:.0f} s")
