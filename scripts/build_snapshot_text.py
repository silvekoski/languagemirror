"""Cleaned text of every vector snapshot (data/timesearch/snapshots.parquet), keyed by rev_id, so the RAG
answer reads each source with one primary-key lookup instead of a cold FOR SYSTEM_TIME AS OF read deep in
the history table (seconds each on chili's HDD). Same versions as the vectors; citations still point at
the exact Wikipedia version (?oldid=rev_id). Runs on chili:
    cj run -n wt-snaptext -c 4 -m 8G -t 1h -- bash -c 'DB_HOST=100.73.11.93 .venv/bin/python -m scripts.build_snapshot_text'"""
import glob, time
from concurrent.futures import ProcessPoolExecutor
import pyarrow.parquet as pq
from wikitime.db import connect
from wikitime.wikitext import clean

CAP = 12000
t0 = time.time()
want = set(pq.read_table("data/timesearch/snapshots.parquet", columns=["rev_id"]).column("rev_id").to_pylist())
con = connect(autocommit=True); cur = con.cursor()
cur.execute("""CREATE TABLE IF NOT EXISTS snapshot_text (
  rev_id INT UNSIGNED NOT NULL PRIMARY KEY, page_id INT UNSIGNED NOT NULL, title VARCHAR(255) NOT NULL,
  text MEDIUMTEXT COMPRESSED NOT NULL, KEY (page_id))""")
cur.execute("SELECT rev_id FROM snapshot_text"); want -= {r[0] for r in cur.fetchall()}
print(f"{len(want)} snapshots to write", flush=True)


def prep(r):
    blocks = [(k, x) for k, x in clean(r["text"] or "") if k in ("p", "li", "h") and len(x) > 2]
    out, n = [], 0
    for k, x in blocks:
        x = ("## " + x) if k == "h" else x
        if n + len(x) > CAP:
            break
        out.append(x); n += len(x) + 2
    return (r["rev_id"], r["page_id"], r["title"], "\n\n".join(out))


done = 0
with ProcessPoolExecutor(4) as ex:
    for f in sorted(glob.glob("data/m/versions-*.parquet")):
        pf = pq.ParquetFile(f)
        batch = []
        for g in range(pf.metadata.num_row_groups):
            rs = [r for r in pf.read_row_group(g, columns=["page_id", "rev_id", "title", "text"]).to_pylist()
                  if r["rev_id"] in want]
            batch += rs
        for i in range(0, len(batch), 400):
            rows = list(ex.map(prep, batch[i:i + 400], chunksize=20))
            cur.executemany("INSERT IGNORE INTO snapshot_text VALUES (%s,%s,%s,%s)", rows)
            done += len(rows)
        print(f"{f}: {done} written ({time.time() - t0:.0f} s)", flush=True)
print(f"done {done} in {time.time() - t0:.0f} s")
