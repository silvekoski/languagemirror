"""Kielipeili, step 4: who resembles whom, over time. For every article, every ordered language pair (a, b) and
every snapshot year, store the share of a's text that has a counterpart in b, read with FOR SYSTEM_TIME AS OF
1 January (app/kielipeili.py: SCORE_SQL). This shows, for instance, a language version drifting towards the
Russian framing in some year. ~1,600 statements, run in parallel.
    uv run python -m scripts.lens_pairs"""
from concurrent.futures import ThreadPoolExecutor

from app import kielipeili as K
from wikitime.db import connect


def main():
    con = connect(); cur = con.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS lens_pair (topic VARCHAR(100) NOT NULL, a CHAR(3) NOT NULL, b CHAR(3) NOT NULL,
        year VARCHAR(4) NOT NULL, coverage DOUBLE, similarity DOUBLE, PRIMARY KEY (topic, a, b, year))""")
    cur.execute("SELECT DISTINCT topic FROM lens_chunk")
    topics = [r[0] for r in cur.fetchall()]
    con.commit()
    points = [(str(y), f"{y}-01-01 00:00:00") for y in K.YEARS] + [("now", K.now())]
    jobs = [(t, a, b, label, ts) for t in topics for a in K.LANGS for b in K.LANGS if a != b for label, ts in points]
    print(len(jobs), "pair scores", flush=True)

    def run(j):
        t, a, b, label, ts = j
        sc = K.score(t, b, ts, ref=a)
        return t, a, b, label, sc["coverage"], sc["similarity"]

    with ThreadPoolExecutor(8) as ex:
        out = list(ex.map(run, jobs))
    cur.execute("DELETE FROM lens_pair")
    cur.executemany("INSERT INTO lens_pair VALUES (%s,%s,%s,%s,%s,%s)", out)
    con.commit()
    print("lens_pair rows:", len(out), flush=True)


if __name__ == "__main__":
    main()
