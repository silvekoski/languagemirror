"""Bake the 3D galaxy: data/galaxy/coords.parquet (from scripts/project_3d.py on chili) + MariaDB
-> table galaxy_point, and web/data/galaxy.json for the page.
    uv run python -m scripts.build_galaxy"""
import base64, json, math, os, time
from collections import Counter, defaultdict
import numpy as np, pyarrow.parquet as pq
from wikitime.db import connect

Y0, Y1 = 2003, 2026
t0 = time.time()
tb = pq.read_table("data/galaxy/coords.parquet").to_pydict()
N = len(tb["page_id"])
xyz = np.stack([tb["x"], tb["y"], tb["z"]], 1).astype(np.float32)
cl = np.array(tb["cluster"])

# Noise points take the cluster of their nearest clustered neighbour in 3D, so every star has a colour.
lab = np.where(cl >= 0)[0]
for i in np.where(cl < 0)[0]:
    cl[i] = cl[lab[np.argmin(((xyz[lab] - xyz[i]) ** 2).sum(1))]]

con = connect()
cur = con.cursor()
cur.execute("""CREATE TABLE IF NOT EXISTS galaxy_point (
  lang CHAR(2) NOT NULL, page_id INT UNSIGNED NOT NULL, x FLOAT, y FLOAT, z FLOAT, cluster SMALLINT,
  PRIMARY KEY (lang, page_id), KEY (cluster))""")
cur.execute("TRUNCATE galaxy_point")
cur.executemany("INSERT INTO galaxy_point VALUES (%s,%s,%s,%s,%s,%s)",
                [(tb["lang"][i], tb["page_id"][i], *map(float, xyz[i]), int(cl[i])) for i in range(N)])
con.commit()

cur.execute("SELECT lang, page_id, title, wikidata_id FROM current_article")
meta = {(l, p): (t, w) for l, p, t, w in cur.fetchall()}
cur.execute("""SELECT page_id, YEAR(ts) y, COUNT(*) n, MIN(ts) FROM revision GROUP BY page_id, y""")
act, birth, versions = defaultdict(lambda: [0] * (Y1 - Y0 + 1)), {}, Counter()
for p, y, n, first in cur.fetchall():
    act[p][y - Y0] = n
    versions[p] += n
    fy = first.year + (first.timetuple().tm_yday - 1) / 366
    birth[p] = min(birth.get(p, 9999), fy)
cur.execute("SELECT lang, page_id, category FROM article_category")
cats = defaultdict(list)
for l, p, c in cur.fetchall():
    cats[(l, p)].append(c)

keys = list(zip(tb["lang"], tb["page_id"]))
fi_by_wd = {meta[k][1]: k[1] for k in keys if k[0] == "fi" and meta.get(k, (0, None))[1]}

# Per star: birth year (fi: first edit; sv/en: the Finnish article's), versions, yearly activity.
B, V, A = [], [], np.zeros((N, Y1 - Y0 + 1), np.uint8)
for i, (l, p) in enumerate(keys):
    fp = p if l == "fi" else fi_by_wd.get(meta.get((l, p), (0, None))[1])
    B.append(round(birth[fp], 3) if fp in birth else None)
    if l == "fi":
        V.append(versions[p])
        # log scale: 255 ~ 1000+ edits in a year
        A[i] = [min(255, round(80 * math.log10(1 + n))) for n in act[p]]
    else:
        V.append(0)

# Cluster labels: the category most characteristic of the cluster (count x specificity).
glob_n = Counter(c for v in cats.values() for c in set(v))
clusters, used = [], set()
for c in sorted(set(cl.tolist()), key=lambda c: -(cl == c).sum()):   # big clusters choose first
    idx = np.where(cl == c)[0]
    cnt = Counter(cat for i in idx for cat in set(cats.get(keys[i], [])))
    ranked = sorted(cnt, key=lambda k: -cnt[k] * (cnt[k] / glob_n[k]) ** 0.7)
    best = next((k for k in ranked if k not in used), None)
    used.add(best)
    top = max(idx, key=lambda i: V[i])
    clusters.append({"id": c, "label": best or meta[keys[top]][0], "size": len(idx),
                     "top": meta[keys[top]][0], "x": float(xyz[idx, 0].mean()),
                     "y": float(xyz[idx, 1].mean()), "z": float(xyz[idx, 2].mean())})

# Cross-language bridges: the same topic (wikidata id) in two languages.
by_wd = defaultdict(list)
for i, k in enumerate(keys):
    w = meta.get(k, (0, None))[1]
    if w:
        by_wd[w].append(i)
links = [(g[a], g[b]) for g in by_wd.values() for a in range(len(g)) for b in range(a + 1, len(g))]

out = {
    "n": N, "years": [Y0, Y1],
    "xyz": [round(float(v), 3) for v in xyz.ravel()],
    "lang": "".join({"fi": "f", "sv": "s", "en": "e"}[l] for l in tb["lang"]),
    "page_id": tb["page_id"], "title": [meta.get(k, ("?",))[0] for k in keys],
    "cluster": cl.tolist(), "birth": B, "versions": V,
    "activity": base64.b64encode(A.tobytes()).decode(),
    "clusters": clusters, "links": [v for pair in links for v in pair],
}
os.makedirs("web/data", exist_ok=True)
with open("web/data/galaxy.json", "w") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"{N} stars, {len(clusters)} clusters, {len(links)} bridges, "
      f"{os.path.getsize('web/data/galaxy.json') / 1e6:.1f} MB, {time.time() - t0:.0f} s")
for c in sorted(clusters, key=lambda c: -c["size"])[:15]:
    print(f"  {c['size']:5d}  {c['label']}  (top: {c['top']})")
