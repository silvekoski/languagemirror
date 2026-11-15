"""Typewriter precompute: per-version lead-diff stats for a picker set of articles with text.

Picker set: the 50 famous heavily edited articles (data/lists/reference50.tsv) plus the 30 most-edited
other articles that have stored text. For each, app.typewriter.compute_versions runs one
FOR SYSTEM_TIME ALL query (only changed leads cross the network) and diffs the cleaned leads.

  viz_typewriter_version  page_id, seq -> rev_id, ts, editor, flags, words added/removed in the lead
  viz_typewriter_article  page_id -> title, counts, biggest lead change

Idempotent (recreates its tables; resumes per article with --resume).
    nice -n 10 .venv/bin/python -m scripts.build_typewriter [--resume]
"""
import sys
import time

from app.typewriter import compute_versions
from wikitime.db import connect

con = connect()
cur = con.cursor()
resume = "--resume" in sys.argv
if not resume:
    cur.execute("DROP TABLE IF EXISTS viz_typewriter_version")
    cur.execute("DROP TABLE IF EXISTS viz_typewriter_article")
cur.execute("""CREATE TABLE IF NOT EXISTS viz_typewriter_version (
  page_id INT UNSIGNED NOT NULL, seq INT NOT NULL, rev_id INT UNSIGNED, ts DATETIME(6),
  user VARCHAR(255), anonymous TINYINT, bot TINYINT, minor TINYINT, is_revert TINYINT,
  delta INT, len INT, comment VARCHAR(500), lead_changed TINYINT, w_add INT, w_del INT, lead_words INT,
  PRIMARY KEY (page_id, seq))""")
cur.execute("""CREATE TABLE IF NOT EXISTS viz_typewriter_article (
  page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255), famous TINYINT, versions INT, lead_changes INT,
  reverts INT, anon INT, bots INT, editors INT, first_ts DATETIME(6), last_ts DATETIME(6),
  biggest_seq INT, lead_words INT)""")
con.commit()

famous = [int(l.split("\t")[0]) for l in open("data/lists/reference50.tsv").read().splitlines()[1:]]
cur.execute("""SELECT page_id FROM revision WHERE page_id IN (SELECT page_id FROM article)
               GROUP BY page_id ORDER BY COUNT(*) DESC LIMIT 100""")
extra = [r[0] for r in cur.fetchall() if r[0] not in famous][:30]
cur.execute("SELECT page_id FROM viz_typewriter_article")
done = {r[0] for r in cur.fetchall()}

for n, pid in enumerate(famous + extra):
    if pid in done:
        continue
    t = time.time()
    title, v = compute_versions(pid)
    if not v:
        continue
    cur.execute("DELETE FROM viz_typewriter_version WHERE page_id=%s", (pid,))
    cur.executemany("INSERT INTO viz_typewriter_version VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    [(pid, x["seq"], x["rev_id"], x["ts"], x["user"][:255], x["anonymous"], x["bot"],
                      x["minor"], x["is_revert"], x["delta"], x["len"], x["comment"], x["lead_changed"],
                      x["w_add"], x["w_del"], x["lead_words"]) for x in v])
    big = max(v[1:] or v, key=lambda x: x["w_add"] + x["w_del"])
    cur.execute("REPLACE INTO viz_typewriter_article VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (pid, title, int(pid in famous), len(v), sum(x["lead_changed"] for x in v),
                 sum(x["is_revert"] for x in v), sum(x["anonymous"] for x in v), sum(x["bot"] for x in v),
                 len({x["user"] for x in v}), v[0]["ts"], v[-1]["ts"], big["seq"], v[-1]["lead_words"]))
    con.commit()
    print(f"{n:3d} {pid:8d} {title[:40]:40s} {len(v):5d} versions {time.time() - t:5.1f}s", flush=True)
print("done")
