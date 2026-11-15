"""Load dataset S (data/s): current fi/sv/en articles, bge-m3 vectors, categories.
    uv run python -m scripts.load_s
Idempotent: INSERT IGNORE, so it can be rerun."""
import csv, time
import pyarrow.parquet as pq
from wikitime.db import connect

D = "data/s"
con = connect()
cur = con.cursor()


def chunks(rows, n):
    for i in range(0, len(rows), n):
        yield rows[i:i + n]


t = time.time()
for lang in ("fi", "sv", "en"):
    tb = pq.read_table(f"{D}/articles-{lang}.parquet").to_pylist()
    rows = [(r["lang"], r["page_id"], r["rev_id"], r["wikidata_id"], r["title"], r["url"],
             (r["date_modified"] or "")[:19].replace("T", " ") or None, r["text"]) for r in tb]
    for c in chunks(rows, 200):
        cur.executemany("INSERT IGNORE INTO current_article VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", c)
    con.commit()
    print(f"articles {lang}: {len(rows)}  ({time.time() - t:.0f} s)", flush=True)

    vt = pq.read_table(f"{D}/vectors-bge-m3-{lang}.parquet")
    emb = vt.column("embedding").combine_chunks()
    flat = emb.values.to_numpy().reshape(-1, 1024).astype("<f4")
    meta = vt.drop_columns(["embedding"]).to_pylist()
    rows = [(m["lang"], m["page_id"], m["model"], m["truncated"], flat[i].tobytes())
            for i, m in enumerate(meta)]
    for c in chunks(rows, 500):   # VECTOR accepts the raw little-endian float32 bytes
        cur.executemany("INSERT IGNORE INTO article_vector VALUES (%s,%s,%s,%s,%s)", c)
    con.commit()
    print(f"vectors  {lang}: {len(rows)}  ({time.time() - t:.0f} s)", flush=True)

links = [(r["parent"], r["child"]) for r in csv.DictReader(open(f"{D}/category-links-fi.tsv"), delimiter="\t")]
cur.executemany("INSERT IGNORE INTO category_link VALUES (%s,%s)", links)
cats = [("fi", int(r["page_id"]), r["category"])
        for r in csv.DictReader(open(f"{D}/article-categories-fi.tsv"), delimiter="\t")]
for c in chunks(cats, 5000):
    cur.executemany("INSERT IGNORE INTO article_category VALUES (%s,%s,%s)", c)
# sv/en articles inherit the categories of the Finnish article on the same topic
cur.execute("""INSERT IGNORE INTO article_category
  SELECT o.lang, o.page_id, c.category FROM current_article o
  JOIN current_article f ON f.lang='fi' AND f.wikidata_id=o.wikidata_id
  JOIN article_category c ON c.lang='fi' AND c.page_id=f.page_id
  WHERE o.lang IN ('sv','en')""")
con.commit()
cur.execute("SELECT (SELECT COUNT(*) FROM current_article),(SELECT COUNT(*) FROM article_vector),"
            "(SELECT COUNT(*) FROM category_link),(SELECT COUNT(*) FROM article_category)")
print("articles, vectors, category links, article categories:", cur.fetchone(), f"{time.time() - t:.0f} s")
