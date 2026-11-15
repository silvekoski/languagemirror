"""Precompute the "Biggest Stories" bar chart race: monthly top-20 frames for two rankings.
    nice .venv/bin/python -m scripts.build_race

  bytes : largest articles by size at the end of each month (bytes of the last version up to then)
  edits : most edited articles in the trailing 12 months (human edits: users not ending in 'bot')

One set-based query on `revision` collapses 862k versions into ~370k (page, month) rows inside
MariaDB; numpy carries sizes forward and ranks every month. Writes (idempotent, ~1 MB):
  viz_race_frame (mode, ym, rnk, page_id, value, title)   top 20 per month and mode
  viz_race_month (ym, articles, total_bytes, edits, human_edits, busiest_page, busiest_n, busiest_title)
  viz_race_page  (page_id, title, cluster, cluster_idx, cluster_label)  pages that appear in a frame
"""
import json, pathlib, time
import numpy as np
from wikitime.db import connect

TOP = 20
ROOT = pathlib.Path(__file__).resolve().parent.parent

MONTHLY_SQL = """
SELECT page_id, ym, bytes, title, n, nh FROM (
  SELECT page_id, EXTRACT(YEAR_MONTH FROM ts) AS ym, bytes, title,
         ROW_NUMBER() OVER (PARTITION BY page_id, EXTRACT(YEAR_MONTH FROM ts) ORDER BY ts DESC, rev_id DESC) AS rn,
         COUNT(*)     OVER (PARTITION BY page_id, EXTRACT(YEAR_MONTH FROM ts)) AS n,
         SUM(LOWER(COALESCE(user, '')) NOT LIKE '%%bot') OVER (PARTITION BY page_id, EXTRACT(YEAR_MONTH FROM ts)) AS nh
  FROM revision) v
WHERE rn = 1"""


def months(a, b):
    out, y, m = [], a // 100, a % 100
    while y * 100 + m <= b:
        out.append(y * 100 + m)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def main():
    t0 = time.time()
    con = connect()
    cur = con.cursor()
    cur.execute(MONTHLY_SQL)
    data = cur.fetchall()
    print(f"{len(data):,} page-months in {time.time() - t0:.1f}s")

    M = months(200302, 202609)                     # 2026-10 holds a single day; stop at September
    mi = {ym: i for i, ym in enumerate(M)}
    pages = sorted({r[0] for r in data})
    pi = {p: i for i, p in enumerate(pages)}
    NM, NP = len(M), len(pages)

    by_month = [[] for _ in M]
    cnt = np.zeros((NM, NP), np.int32)
    hum = np.zeros((NM, NP), np.int32)
    for p, ym, b, title, n, nh in data:
        i = mi.get(int(ym))
        if i is None:
            continue
        by_month[i].append((pi[p], int(b), title))
        cnt[i, pi[p]] = n
        hum[i, pi[p]] = nh
    # trailing 12-month human edits: cumulative sum minus the sum 12 months earlier
    cs = np.cumsum(hum, 0)
    trail = cs.copy()
    trail[12:] -= cs[:-12]

    size = np.full(NP, -1, np.int64)                # -1 = page did not exist yet
    title = [None] * NP
    frames, month_rows, appear = [], [], set()
    for i, ym in enumerate(M):
        for j, b, t in by_month[i]:
            size[j], title[j] = b, t
        for mode, val in (("bytes", size), ("edits", trail[i])):
            top = np.argpartition(-val, TOP)[:TOP]
            top = top[np.lexsort((top, -val[top]))]
            for r, j in enumerate(top):
                if val[j] <= 0:
                    break
                frames.append((mode, ym, r + 1, pages[j], int(val[j]), title[j]))
                appear.add(j)
        b = int(np.argmax(hum[i]))
        month_rows.append((ym, int((size >= 0).sum()), int(size[size > 0].sum()), int(cnt[i].sum()),
                           int(hum[i].sum()), pages[b], int(hum[i, b]), title[b]))

    # cluster colours/labels, consistent with the Knowledge Galaxy (index in its cluster list)
    g = json.loads((ROOT / "web/data/galaxy.json").read_text())
    cidx = {c["id"]: (i, c["label"]) for i, c in enumerate(g["clusters"])}
    ids = [pages[j] for j in appear]
    cur.execute("SELECT page_id, cluster FROM galaxy_point WHERE lang='fi' AND page_id IN (%s)"
                % ",".join(map(str, ids)))
    cl = dict(cur.fetchall())
    cur.execute("SELECT page_id, title FROM current_article WHERE lang='fi' AND page_id IN (%s)"
                % ",".join(map(str, ids)))
    cur_title = dict(cur.fetchall())
    page_rows = []
    for j in appear:
        p = pages[j]
        c = cl.get(p)
        ci, lab = cidx.get(c, (None, None))
        page_rows.append((p, cur_title.get(p) or title[j], c, ci, lab))

    cur.execute("DROP TABLE IF EXISTS viz_race_frame, viz_race_month, viz_race_page")
    cur.execute("""CREATE TABLE viz_race_frame (mode VARCHAR(8) NOT NULL, ym INT NOT NULL, rnk TINYINT NOT NULL,
        page_id INT UNSIGNED NOT NULL, value INT NOT NULL, title VARCHAR(255),
        PRIMARY KEY (mode, ym, rnk), KEY (page_id))""")
    cur.execute("""CREATE TABLE viz_race_month (ym INT PRIMARY KEY, articles INT, total_bytes BIGINT, edits INT,
        human_edits INT, busiest_page INT UNSIGNED, busiest_n INT, busiest_title VARCHAR(255))""")
    cur.execute("""CREATE TABLE viz_race_page (page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255),
        cluster SMALLINT, cluster_idx SMALLINT, cluster_label VARCHAR(255))""")
    cur.executemany("INSERT INTO viz_race_frame VALUES (%s,%s,%s,%s,%s,%s)", frames)
    cur.executemany("INSERT INTO viz_race_month VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", month_rows)
    cur.executemany("INSERT INTO viz_race_page VALUES (%s,%s,%s,%s,%s)", page_rows)
    con.commit()
    print(f"{len(frames)} frame rows, {len(month_rows)} months, {len(page_rows)} pages in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
