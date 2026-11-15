"""Load dataset M (data/m): every version of the History of Finland articles.

    uv run python -m scripts.load_m                 # metadata of all versions + text for the default set
    uv run python -m scripts.load_m --max-mb 2      # text for every article with < 2 MB of history
    uv run python -m scripts.load_m --skip-meta     # only (more) text

1. `revision`: metadata of all 862k versions (who, when, size, delta, revert flag), computed in DuckDB.
2. `article`: full text of every version for articles whose whole history is under --max-mb of
   wikitext, plus data/lists/*.tsv (the reference demo's 50 famous, heavily edited articles).
   Written with Wikipedia's real edit times (system_versioning_insert_history): each version's
   row_start is when it was saved, row_end when the next one was. The current version has no end.
Resumable: articles already in `article` are skipped.
"""
import argparse, bisect, csv, glob, time
from datetime import timedelta
import duckdb
import pyarrow.parquet as pq
from wikitime.db import connect

ap = argparse.ArgumentParser()
ap.add_argument("--max-mb", type=float, default=0.5)
ap.add_argument("--skip-meta", action="store_true")
ap.add_argument("--skip-text", action="store_true")
args = ap.parse_args()

FILES = sorted(glob.glob("data/m/versions-*.parquet"))
BATCH_BYTES = 8_000_000
con = connect()
cur = con.cursor()
dk = duckdb.connect()
dk.sql("SET TimeZone = 'UTC'")
dk.sql(f"""CREATE VIEW v AS SELECT page_id, title, rev_id, parent_id, timestamp::TIMESTAMP AS ts, "user",
           anonymous, minor, sha1, bytes, comment FROM read_parquet({FILES!r})""")
t0 = time.time()

# --- which articles get their text --------------------------------------------------------------
sizes = dict(dk.sql("SELECT page_id, SUM(bytes) FROM v GROUP BY 1").fetchall())
wanted = {p for p, b in sizes.items() if b < args.max_mb * 1e6}
for f in glob.glob("data/lists/*.tsv"):
    wanted |= {int(r["page_id"]) for r in csv.DictReader(open(f), delimiter="\t")} & sizes.keys()
print(f"text for {len(wanted)} of {len(sizes)} articles, "
      f"{sum(sizes[p] for p in wanted) / 1e9:.2f} GB of wikitext", flush=True)

# --- 1. metadata of every version ---------------------------------------------------------------
if not args.skip_meta:
    cur.execute("SELECT COUNT(*) FROM revision")
    if cur.fetchone()[0] < 862_076:              # partial or empty: start over
        cur.execute("TRUNCATE revision")
        rows = dk.sql("""
          SELECT rev_id, parent_id, page_id, title, ts, "user", anonymous, minor, sha1, bytes,
                 bytes::BIGINT - LAG(bytes) OVER w AS delta,
                 COALESCE(sha1 <> LAG(sha1) OVER w
                          AND MIN(ts) OVER (PARTITION BY page_id, sha1) < ts, false) AS is_revert,
                 comment
          FROM v WINDOW w AS (PARTITION BY page_id ORDER BY ts, rev_id)""").fetchall()
        sql = "INSERT IGNORE INTO revision (rev_id,parent_id,page_id,title,ts,user,anonymous,minor,sha1,bytes,delta,is_revert,comment) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
        for i in range(0, len(rows), 5000):
            cur.executemany(sql, rows[i:i + 5000])
            con.commit()
        print(f"revision: {len(rows)} rows ({time.time() - t0:.0f} s)", flush=True)
        del rows
    else:
        print("revision: already loaded")

# --- 2. full text into the system-versioned table -----------------------------------------------
INSERT = """INSERT INTO article (page_id,title,rev_id,user,anonymous,comment,minor,sha1,len,text,row_start{})
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s{})"""


def save(page_id, vs):
    vs.sort(key=lambda r: (r["timestamp"], r["rev_id"]))
    times = [r["timestamp"].replace(tzinfo=None) for r in vs]
    for i in range(1, len(times)):                 # same millisecond: keep order, 1 µs apart
        if times[i] <= times[i - 1]:
            times[i] = times[i - 1] + timedelta(microseconds=1)
    rows = [(page_id, r["title"], r["rev_id"], r["user"], r["anonymous"], r["comment"], r["minor"],
             r["sha1"], r["bytes"], r["text"] or "", times[i]) for i, r in enumerate(vs)]
    history = [r + (times[i + 1],) for i, r in enumerate(rows[:-1])]
    batch, size = [], 0
    for row in history + [None]:
        if batch and (row is None or size + len(row[9]) * 2 > BATCH_BYTES):
            cur.executemany(INSERT.format(",row_end", ",%s"), batch)
            batch, size = [], 0
        if row is not None:
            batch.append(row)
            size += len(row[9]) * 2
    cur.execute(INSERT.format("", ""), rows[-1])
    con.commit()


if not args.skip_text:
    cur.execute("SET system_versioning_insert_history = 1")
    cur.execute("SELECT DISTINCT page_id FROM article FOR SYSTEM_TIME ALL")
    todo = wanted - {p for (p,) in cur.fetchall()}
    print(f"article: {len(wanted) - len(todo)} already loaded, {len(todo)} to go", flush=True)
    done = nver = 0
    for f in FILES:
        pf = pq.ParquetFile(f)
        md = pf.metadata
        groups, ids = [], sorted(todo)
        for g in range(md.num_row_groups):         # read only row groups holding a wanted page
            st = md.row_group(g).column(0).statistics
            i = bisect.bisect_left(ids, st.min)
            if i < len(ids) and ids[i] <= st.max:
                groups.append(g)
        if not groups:
            continue
        # A page's versions are contiguous in its file: save each article as soon as it ends,
        # so only one article's history is in memory at a time.
        cur_page, buf, n_pages = None, [], 0
        for g in groups:
            for r in pf.read_row_group(g).to_pylist():
                if r["page_id"] != cur_page:
                    if buf:
                        save(cur_page, buf); done += 1; n_pages += 1; nver += len(buf)
                        todo.discard(cur_page)
                    cur_page, buf = r["page_id"], []
                if r["page_id"] in todo:
                    buf.append(r)
        if buf:
            save(cur_page, buf); done += 1; n_pages += 1; nver += len(buf)
            todo.discard(cur_page)
        print(f"{f}: {n_pages} articles, total {done} articles / {nver} versions "
              f"({time.time() - t0:.0f} s)", flush=True)
    cur.execute("UPDATE revision r JOIN (SELECT DISTINCT page_id FROM article) a USING (page_id) SET r.has_text = 1")
    con.commit()

cur.execute("SELECT COUNT(DISTINCT page_id), COUNT(*) FROM article FOR SYSTEM_TIME ALL")
print("article (all versions): articles, versions =", cur.fetchone(), f"({time.time() - t0:.0f} s)")
