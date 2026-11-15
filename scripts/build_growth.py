"""Growing Tree precompute: how the category tree under 'Suomen historia' filled up, 2003 -> 2026.

The category tree is a DAG (256 categories have several parents). For layout every category gets ONE
parent: the one on its shortest path from the root (breadth-first search; ties go to the parent that is
alphabetically first). Articles often sit in several categories; an article's bytes / count / edits are
split evenly between its categories so that the sunburst adds up to the true total.

An article's size at time T = `bytes` of its last version with ts <= T (from `revision`); before its
first version it contributes nothing. Categories are today's (the dataset has no category history).

Tables (all rebuilt from scratch, idempotent):
  viz_growth_cat           cat_id, name, layout parent, depth, top-level branch, all parents, direct articles
  viz_growth_frame         q 0..94: quarter ends 2003Q1 .. 2026Q3 (the last frame also holds the data's
                           final day, 1 Oct 2026)
  viz_growth_article       page_id -> title, first edit, number of categories
  viz_growth_article_year  page_id x year end (2003..2025, 2026 = data end) -> bytes, rev_id of that
                           version, cumulative edits, edits that year
  viz_growth_cat_page      closure of the layout tree: cat_id x page_id in its subtree, with the share
                           of the article that the subtree's arcs carry
  viz_growth_cat_series    cat_id x measure (b/a/e) -> the category's OWN (direct-article, split) bytes /
                           articles / cumulative edits at the 95 quarter ends, as a JSON array
  viz_growth_year          year -> articles, bytes, newborn articles, edits, and the 3 articles that grew most
  viz_growth_blob          'tree' -> the gzipped JSON that /api/growth/tree serves (one 0.5 MB row instead of
                           several MB of series over the tunnel)

    nice -n 10 .venv/bin/python -m scripts.build_growth          # everything
    nice -n 10 .venv/bin/python -m scripts.build_growth blob     # only re-bake viz_growth_blob
"""
import gzip
import sys
import json
import time
from collections import defaultdict, deque

import numpy as np
from wikitime.db import connect

ROOT = "Suomen historia"
Y0, Y1 = 2003, 2026
Q0 = Y0 * 4                      # quarter index = year*4 + quarter-1
NQ = (Y1 - Y0) * 4 + 3           # 2003Q1 .. 2026Q3 -> 95 frames
LAST = Q0 + NQ - 1               # revisions after 2026-09-30 (the final day, 1 Oct) fold into the last frame

# one pass over revision: per (page, quarter) the last version's bytes and rev_id, plus the edit count
QUARTER_SQL = f"""SELECT page_id, q, bytes, rev_id, n FROM (
  SELECT page_id, LEAST(YEAR(ts)*4 + QUARTER(ts) - 1, {LAST}) AS q, bytes, rev_id,
         ROW_NUMBER() OVER (PARTITION BY page_id, LEAST(YEAR(ts)*4 + QUARTER(ts) - 1, {LAST})
                            ORDER BY ts DESC, rev_id DESC) AS rn,
         COUNT(*)     OVER (PARTITION BY page_id, LEAST(YEAR(ts)*4 + QUARTER(ts) - 1, {LAST})) AS n
  FROM revision) t
WHERE rn = 1"""

DDL = [
    "DROP TABLE IF EXISTS viz_growth_cat, viz_growth_frame, viz_growth_cat_q, viz_growth_article, "
    "viz_growth_article_year, viz_growth_cat_page, viz_growth_cat_series, viz_growth_year",
    """CREATE TABLE viz_growth_cat (cat_id SMALLINT UNSIGNED PRIMARY KEY, name VARCHAR(255) NOT NULL,
         parent_id SMALLINT UNSIGNED NULL, depth TINYINT NOT NULL, branch_id SMALLINT UNSIGNED NULL,
         n_parents TINYINT NOT NULL, parents TEXT, n_direct INT NOT NULL, UNIQUE KEY (name))""",
    """CREATE TABLE viz_growth_frame (q TINYINT UNSIGNED PRIMARY KEY, y SMALLINT NOT NULL, quarter TINYINT NOT NULL,
         end_ts DATETIME NOT NULL)""",
    """CREATE TABLE viz_growth_article (page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255) NOT NULL,
         first_ts DATETIME NOT NULL, n_cats TINYINT NOT NULL)""",
    """CREATE TABLE viz_growth_article_year (y SMALLINT NOT NULL, page_id INT UNSIGNED NOT NULL,
         bytes INT UNSIGNED NOT NULL, rev_id INT UNSIGNED NOT NULL, edits INT UNSIGNED NOT NULL,
         edits_y INT UNSIGNED NOT NULL, PRIMARY KEY (y, page_id))""",
    """CREATE TABLE viz_growth_cat_page (cat_id SMALLINT UNSIGNED, page_id INT UNSIGNED, share FLOAT NOT NULL,
         direct TINYINT NOT NULL, PRIMARY KEY (cat_id, page_id))""",
    """CREATE TABLE viz_growth_cat_series (cat_id SMALLINT UNSIGNED, m CHAR(1), vals TEXT NOT NULL,
         PRIMARY KEY (cat_id, m))""",
    """CREATE TABLE viz_growth_year (y SMALLINT PRIMARY KEY, articles INT NOT NULL, bytes BIGINT NOT NULL,
         born INT NOT NULL, edits INT NOT NULL, top TEXT NOT NULL)""",
]


BUILD_SQL = ("-- scripts/build_growth.py: one window-function pass over all 862,076 versions.\n"
             "-- For every article and quarter: the size of its LAST version in that quarter, and the edit count\n"
             "-- (q = year*4 + quarter-1; the data's final day, 1 Oct 2026, folds into the last quarter, 8106).\n"
             + QUARTER_SQL + ";\n"
             "-- Python carries each size forward to later quarters (an article keeps its size until its next\n"
             "-- edit), splits it evenly over the article's categories, and writes viz_growth_cat_series.")


def tree_payload(rows):
    """The JSON the page loads: categories, quarter frames, per-category series, year summaries."""
    cats = rows("SELECT cat_id, name, parent_id, depth, branch_id, n_parents, parents, n_direct "
                "FROM viz_growth_cat ORDER BY cat_id")
    frames = rows("SELECT q, y, quarter, end_ts FROM viz_growth_frame ORDER BY q")
    nc = len(cats)
    own = {m: [None] * nc for m in "bae"}
    for r in rows("SELECT cat_id, m, vals FROM viz_growth_cat_series"):
        own[r["m"]][r["cat_id"]] = json.loads(r["vals"])
    years = rows("SELECT y, articles, bytes, born, edits, top FROM viz_growth_year ORDER BY y")
    for y in years:
        y["top"] = json.loads(y["top"])
    for c in cats:
        c["parents"] = c["parents"].split("\t") if c["parents"] else []
    return {"frames": [{"q": f["q"], "y": f["y"], "quarter": f["quarter"], "end": str(f["end_ts"])} for f in frames],
            "cats": cats, "own": own, "years": years, "sql": BUILD_SQL}


def write_blob():
    from app.db import rows
    raw = json.dumps(tree_payload(rows), separators=(",", ":"), default=str).encode()
    gz = gzip.compress(raw, 6)
    rows("CREATE TABLE IF NOT EXISTS viz_growth_blob (k VARCHAR(16) PRIMARY KEY, v MEDIUMBLOB NOT NULL)")
    rows("REPLACE INTO viz_growth_blob VALUES ('tree', %s)", (gz,))
    print(f"viz_growth_blob: tree {len(raw):,} B raw, {len(gz):,} B gzip")


def main():
    t0 = time.time()
    con = connect()
    cur = con.cursor()

    # ---- the layout tree: BFS shortest path from the root -------------------------------------------
    cur.execute("SELECT parent, child FROM category_link")
    kids, parents = defaultdict(list), defaultdict(list)
    for p, c in cur.fetchall():
        kids[p].append(c)
        parents[c].append(p)
    order, depth, lay = [ROOT], {ROOT: 0}, {}
    dq = deque([ROOT])
    while dq:
        p = dq.popleft()
        for c in sorted(kids[p]):
            if c not in depth:
                depth[c], lay[c] = depth[p] + 1, p
                order.append(c)
                dq.append(c)
    cid = {name: i for i, name in enumerate(order)}

    def branch(c):
        while depth[c] > 1:
            c = lay[c]
        return c if depth[c] == 1 else None

    # ---- articles and their (split) category memberships --------------------------------------------
    cur.execute("SELECT page_id, category FROM article_category WHERE lang='fi'")
    acats = defaultdict(list)
    for pid, c in cur.fetchall():
        if c in cid:
            acats[pid].append(cid[c])
    cur.execute("""SELECT page_id, MIN(ts), (SELECT title FROM revision r2 WHERE r2.page_id=r.page_id
                   ORDER BY ts DESC LIMIT 1) FROM revision r GROUP BY page_id""")
    meta = {pid: (first, title) for pid, first, title in cur.fetchall()}
    cur.execute("SELECT page_id, title FROM current_article WHERE lang='fi'")
    for pid, title in cur.fetchall():
        if pid in meta:
            meta[pid] = (meta[pid][0], title)
    pages = sorted(p for p in acats if p in meta)
    pidx = {p: i for i, p in enumerate(pages)}
    P = len(pages)
    print(f"{len(order)} categories, {P} articles with history  ({time.time() - t0:.0f} s)")

    # ---- per article x quarter: bytes, rev_id, edits (forward-filled / cumulative) ------------------
    B = np.zeros((P, NQ), np.int64)
    R = np.zeros((P, NQ), np.int64)
    E = np.zeros((P, NQ), np.int64)
    seen = np.zeros((P, NQ), bool)
    cur.execute(QUARTER_SQL)
    for pid, q, b, rev, n in cur.fetchall():
        i = pidx.get(pid)
        if i is None:
            continue
        k = q - Q0
        B[i, k], R[i, k], E[i, k], seen[i, k] = b, rev, n, True
    for k in range(1, NQ):                       # carry the last version forward
        keep = ~seen[:, k]
        B[keep, k], R[keep, k] = B[keep, k - 1], R[keep, k - 1]
    born = np.maximum.accumulate(seen, axis=1)
    E = np.cumsum(E, axis=1)
    print(f"quarter matrix {P}x{NQ}, total bytes at end {B[:, -1].sum():,}  ({time.time() - t0:.0f} s)")

    # ---- category own values: each article split evenly between its categories ----------------------
    C = len(order)
    own_b, own_a, own_e = np.zeros((C, NQ)), np.zeros((C, NQ)), np.zeros((C, NQ))
    n_direct = np.zeros(C, int)
    for p in pages:
        cs, i = acats[p], pidx[p]
        w = 1.0 / len(cs)
        for c in cs:
            own_b[c] += w * B[i]
            own_a[c] += w * born[i]
            own_e[c] += w * E[i]
            n_direct[c] += 1

    # ---- closure of the layout tree: every article in every ancestor's subtree ----------------------
    anc = {}
    for c in order:
        anc[cid[c]] = [cid[c]] + (anc[cid[lay[c]]] if c in lay else [])
    closure = defaultdict(lambda: [0.0, 0])      # (cat, page) -> [share, direct]
    for p in pages:
        cs = acats[p]
        w = 1.0 / len(cs)
        for c in cs:
            for a in anc[c]:
                e = closure[(a, p)]
                e[0] += w
                if a == c:
                    e[1] = 1

    # ---- write ---------------------------------------------------------------------------------------
    for sql in DDL:
        cur.execute(sql)
    cur.executemany("INSERT INTO viz_growth_cat VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", [
        (cid[c], c, cid[lay[c]] if c in lay else None, depth[c],
         cid[branch(c)] if branch(c) else None, len(parents[c]),
         "\t".join(sorted(parents[c])) or None, int(n_direct[cid[c]])) for c in order])
    frames = []
    for k in range(NQ):
        y, qq = divmod(Q0 + k, 4)
        end = f"{y}-{3 * qq + 3:02d}-{[31, 30, 30, 31][qq]} 23:59:59"
        if k == NQ - 1:
            end = "2026-10-01 23:59:59"
        frames.append((k, y, qq + 1, end))
    cur.executemany("INSERT INTO viz_growth_frame VALUES (%s,%s,%s,%s)", frames)
    cur.executemany("INSERT INTO viz_growth_article VALUES (%s,%s,%s,%s)", [
        (p, meta[p][1], meta[p][0], len(acats[p])) for p in pages])
    # year ends: Q4 of each year, and the last frame for 2026
    ay = []
    for y in range(Y0, Y1 + 1):
        k = min((y - Y0) * 4 + 3, NQ - 1)
        kp = min((y - 1 - Y0) * 4 + 3, NQ - 1) if y > Y0 else None   # previous year end
        for i in np.nonzero(born[:, k])[0]:
            ey = E[i, k] - (E[i, kp] if kp is not None else 0)
            ay.append((y, pages[i], int(B[i, k]), int(R[i, k]), int(E[i, k]), int(ey)))
    for s in range(0, len(ay), 20000):
        cur.executemany("INSERT INTO viz_growth_article_year VALUES (%s,%s,%s,%s,%s,%s)", ay[s:s + 20000])
    ser = []
    for c in range(C):
        ser.append((c, "b", json.dumps([int(round(x)) for x in own_b[c]], separators=(",", ":"))))
        ser.append((c, "a", json.dumps([round(float(x), 3) for x in own_a[c]], separators=(",", ":"))))
        ser.append((c, "e", json.dumps([round(float(x), 2) for x in own_e[c]], separators=(",", ":"))))
    cur.executemany("INSERT INTO viz_growth_cat_series VALUES (%s,%s,%s)", ser)
    yr = []
    for y in range(Y0, Y1 + 1):
        k = min((y - Y0) * 4 + 3, NQ - 1)
        kp = min((y - 1 - Y0) * 4 + 3, NQ - 1) if y > Y0 else None   # previous year end
        prevB = B[:, kp] if kp is not None else np.zeros(P, np.int64)
        prevBorn = born[:, kp] if kp is not None else np.zeros(P, bool)
        prevE = E[:, kp] if kp is not None else np.zeros(P, np.int64)
        grew = B[:, k] - prevB
        top = [{"page_id": pages[i], "title": meta[pages[i]][1], "grew": int(grew[i]), "bytes": int(B[i, k])}
               for i in np.argsort(-grew, kind="stable")[:3]]
        yr.append((y, int(born[:, k].sum()), int(B[:, k].sum()), int((born[:, k] & ~prevBorn).sum()),
                   int((E[:, k] - prevE).sum()), json.dumps(top, ensure_ascii=False)))
    cur.executemany("INSERT INTO viz_growth_year VALUES (%s,%s,%s,%s,%s,%s)", yr)
    cl = [(a, p, float(v[0]), v[1]) for (a, p), v in closure.items()]
    for s in range(0, len(cl), 20000):
        cur.executemany("INSERT INTO viz_growth_cat_page VALUES (%s,%s,%s,%s)", cl[s:s + 20000])
    con.commit()
    print(f"wrote {C} cats, {len(ser)} category series, {len(ay)} article-years, {len(cl)} closure rows "
          f"({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    if sys.argv[1:] != ["blob"]:
        main()
    write_blob()
