"""Link Web 3D: extract [[wikilinks]] from every article snapshot AS OF the start of 2006, 2010, 2014, 2018,
2022 and today (FOR SYSTEM_TIME AS OF on the system-versioned `article` table), resolve them to our page_ids,
lay the resulting graph out in 3D and store it in viz_linkweb_* tables.
    nice .venv/bin/python -m scripts.build_linkweb            (idempotent; per-snapshot extraction is cached)

Only the link targets travel over the network: REGEXP_REPLACE runs inside MariaDB and reduces each wikitext
to one target per line, so a full snapshot of ~17k articles is a few MB instead of ~80 MB."""
import json, os, pickle, sys, time
from collections import defaultdict
import numpy as np
import pymysql
from wikitime.db import connect

SNAPS = [2006, 2010, 2014, 2018, 2022, 2026]     # 2026 = current version (not AS OF)
CACHE = os.environ.get("LINKWEB_CACHE", "data/linkweb")
MAX_NODES = 4500
RX = r"(?s).*?\[\[([^\]\[|#\n]{1,200})|(?s).+"
SNAP_SQL = """SELECT page_id, REGEXP_REPLACE(text, %s, '\\\\1\\n') AS links
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s"""
NOW_SQL = "SELECT page_id, REGEXP_REPLACE(text, %s, '\\\\1\\n') AS links FROM article"
SKIP_NS = ("tiedosto:", "kuva:", "file:", "image:", "luokka:", "category:", "wikipedia:", "malline:",
           "template:", "käyttäjä:", "user:", "ohje:", "portaali:", "media:", ":")


def norm(t):
    t = " ".join(t.replace("_", " ").split())
    return t[:1].upper() + t[1:] if t else t


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def extract(year):
    """{page_id: [raw link target, ...]} for the snapshot, cached on disk."""
    path = f"{CACHE}/snap_{year}.pkl"
    if os.path.exists(path):
        return pickle.load(open(path, "rb"))
    t = time.time()
    con = connect(cursorclass=pymysql.cursors.SSCursor, read_timeout=3600)
    cur = con.cursor()
    if year == SNAPS[-1]:
        cur.execute(NOW_SQL, (RX,))
    else:
        cur.execute(SNAP_SQL, (RX, f"{year}-01-01 00:00:00"))
    out = {}
    for pid, links in cur:
        out[pid] = [l for l in (links or "").split("\n") if l.strip()]
    con.close()
    os.makedirs(CACHE, exist_ok=True)
    pickle.dump(out, open(path, "wb"))
    log(f"snapshot {year}: {len(out)} pages, {sum(map(len, out.values()))} raw links, {time.time() - t:.0f}s")
    return out


def title_map(cur):
    """normalised title -> page_id. Current title (the latest one in `revision`) wins; older titles of the
    same page are kept as aliases (Wikipedia leaves redirects behind on renames)."""
    cur.execute("SELECT page_id, title, MAX(ts) last FROM revision GROUP BY page_id, title")
    by_page = defaultdict(list)
    for pid, title, last in cur.fetchall():
        by_page[pid].append((last, title))
    current, alias = {}, {}
    for pid, ts in by_page.items():
        ts.sort(reverse=True)
        current[norm(ts[0][1])] = pid
        for _, t in ts[1:]:
            alias.setdefault(norm(t), pid)
    titles = {pid: ts[0][1] for pid, ts in by_page.items()}
    return {**alias, **current}, titles


def layout(n, src, dst, init, iters=220, seed=7):
    """Small 3D force layout (springs on links, all-pairs repulsion in chunks), started from the galaxy's
    meaning-based UMAP coordinates so topical neighbourhoods stay together."""
    rng = np.random.default_rng(seed)
    pos = init.astype(np.float32).copy()
    pos = (pos - pos.mean(0)) / (pos.std() + 1e-6) * 30 + rng.normal(0, 0.5, pos.shape).astype(np.float32)
    w = np.ones(len(src), np.float32)
    deg = np.bincount(src, minlength=n) + np.bincount(dst, minlength=n)
    temp = 3.0
    for it in range(iters):
        disp = np.zeros_like(pos)
        smp = rng.choice(n, min(n, 500), replace=False)   # repulsion k^2/d against a random sample
        d = pos[:, None, :] - pos[None, smp, :]
        r2 = (d ** 2).sum(-1) + 0.5
        disp += (d * (40.0 * n / len(smp) / r2)[..., None]).sum(1)
        d = pos[dst] - pos[src]                           # attraction  d^2 / k, damped for hubs
        r = np.sqrt((d ** 2).sum(-1)) + 1e-6
        f = (d * (r * w / 12.0 / np.sqrt(1 + np.minimum(deg[src], deg[dst])))[:, None])
        np.add.at(disp, src, f)
        np.add.at(disp, dst, -f)
        disp -= pos * 0.02                                # gravity
        L = np.sqrt((disp ** 2).sum(-1, keepdims=True)) + 1e-6
        pos += disp / L * np.minimum(L, temp)
        temp = max(0.15, temp * 0.985)
        if it % 50 == 0:
            log(f"layout iter {it}")
    return pos - pos.mean(0)


def main():
    con = connect()
    cur = con.cursor()
    tmap, titles = title_map(cur)
    log(f"title map: {len(tmap)} titles -> {len(titles)} pages")

    snaps = {y: extract(y) for y in SNAPS}
    present = {y: set(s) for y, s in snaps.items()}
    edges = defaultdict(int)                               # (src, dst) -> bitmask of snapshots
    unresolved = 0
    for k, y in enumerate(SNAPS):
        for pid, links in snaps[y].items():
            seen = set()
            for l in links:
                l = l.strip()
                if not l or l.lower().startswith(SKIP_NS):
                    continue
                dst = tmap.get(norm(l))
                if dst is None:
                    unresolved += 1
                    continue
                if dst != pid and dst not in seen:
                    seen.add(dst)
                    edges[(pid, dst)] |= 1 << k
    log(f"{len(edges)} distinct resolved edges, {unresolved} unresolved link occurrences")

    # Node selection: drop isolated articles, keep the MAX_NODES with the highest total degree (any snapshot).
    deg = defaultdict(int)
    for (s, d) in edges:
        deg[s] += 1
        deg[d] += 1
    nodes = sorted(deg, key=lambda p: -deg[p])[:MAX_NODES]
    idx = {p: i for i, p in enumerate(nodes)}
    E = [(idx[s], idx[d], m) for (s, d), m in edges.items() if s in idx and d in idx]
    log(f"kept {len(nodes)} of {len(deg)} linked articles, {len(E)} of {len(edges)} edges")

    cur.execute("SELECT page_id, x, y, z, cluster FROM galaxy_point WHERE lang='fi'")
    gp = {r[0]: r[1:] for r in cur.fetchall()}
    init = np.array([gp.get(p, (0, 0, 0, -1))[:3] for p in nodes], np.float32)
    src = np.array([e[0] for e in E]); dst = np.array([e[1] for e in E])
    pos = layout(len(nodes), src, dst, init)

    nmask = []
    for p in nodes:
        m = 0
        for k, y in enumerate(SNAPS):
            if p in present[y]:
                m |= 1 << k
        nmask.append(m)

    labels = {c["id"]: c["label"] for c in json.load(open("web/data/galaxy.json"))["clusters"]}

    cur.execute("""CREATE OR REPLACE TABLE viz_linkweb_nodes (
      i SMALLINT UNSIGNED PRIMARY KEY, page_id INT UNSIGNED NOT NULL, title VARCHAR(255),
      cluster SMALLINT, x FLOAT, y FLOAT, z FLOAT, mask TINYINT UNSIGNED, KEY (page_id))""")
    cur.executemany("INSERT INTO viz_linkweb_nodes VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                    [(i, p, titles.get(p), int(gp.get(p, (0, 0, 0, -1))[3]), *map(float, pos[i]), nmask[i])
                     for i, p in enumerate(nodes)])
    cur.execute("""CREATE OR REPLACE TABLE viz_linkweb_edges (
      src INT UNSIGNED NOT NULL, dst INT UNSIGNED NOT NULL, mask TINYINT UNSIGNED NOT NULL,
      first_year SMALLINT NOT NULL, PRIMARY KEY (src, dst), KEY (dst))""")
    allrows = [(s, d, m, SNAPS[(m & -m).bit_length() - 1]) for (s, d), m in edges.items()]
    for a in range(0, len(allrows), 20000):
        cur.executemany("INSERT INTO viz_linkweb_edges VALUES (%s,%s,%s,%s)", allrows[a:a + 20000])
    cur.execute("""CREATE OR REPLACE TABLE viz_linkweb_clusters (
      cluster SMALLINT PRIMARY KEY, label VARCHAR(255))""")
    cur.executemany("INSERT INTO viz_linkweb_clusters VALUES (%s,%s)", list(labels.items()))
    cur.execute("""CREATE OR REPLACE TABLE viz_linkweb_snapshots (
      year SMALLINT PRIMARY KEY, pages INT, edges_all INT)""")
    cur.executemany("INSERT INTO viz_linkweb_snapshots VALUES (%s,%s,%s)",
                    [(y, len(present[y]), sum(1 for m in edges.values() if m >> k & 1))
                     for k, y in enumerate(SNAPS)])
    con.commit()
    log("done")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "extract":
        for y in sys.argv[2:]:
            extract(int(y))
    else:
        main()
