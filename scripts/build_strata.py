"""Precompute Knowledge Strata (app/strata.py) for the 50 famous articles + the article picker index.
    nice uv run python -m scripts.build_strata                 # index + every famous article not built yet
    nice uv run python -m scripts.build_strata --limit 5       # at most 5 articles this run (keeps runs short)
    nice uv run python -m scripts.build_strata --pages 1256 1275 --force
Idempotent: skips articles whose cached build matches the current revision."""
import argparse, csv, pathlib, time

from app import strata
from app.db import rows
from wikitime.db import connect

ROOT = pathlib.Path(__file__).resolve().parent.parent


def famous_ids():
    with open(ROOT / "data/lists/reference50.tsv") as f:
        return [int(r["page_id"]) for r in csv.DictReader(f, delimiter="\t")]


def build_index():
    fam = {p: i + 1 for i, p in enumerate(famous_ids())}
    stored = rows("SELECT page_id, title FROM article")
    counts = {r["page_id"]: r["n"] for r in rows("SELECT page_id, COUNT(*) n FROM revision GROUP BY page_id")}
    con = connect()
    try:
        with con.cursor() as cur:
            cur.execute("DELETE FROM viz_strata_index")
            data = [(r["page_id"], r["title"], counts.get(r["page_id"]), fam.get(r["page_id"])) for r in stored]
            for a in range(0, len(data), 2000):
                cur.executemany("INSERT INTO viz_strata_index VALUES (%s,%s,%s,%s)", data[a:a + 2000])
        con.commit()
    finally:
        con.close()
    print(f"index: {len(stored)} articles with text, {sum(1 for r in stored if r['page_id'] in fam)} famous")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, nargs="*")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-index", action="store_true")
    a = ap.parse_args()
    strata.ensure_tables()
    if not a.no_index:
        build_index()
    todo = a.pages or famous_ids()
    built = 0
    for pid in todo:
        cur = strata.current_rev(pid)
        if cur is None:
            print(f"{pid}: no text yet, skipped")
            continue
        cached = strata.load_payload(pid)
        if cached and cached[0] == cur and not a.force:
            continue
        t = time.time()
        strata.build(pid, log=print)
        built += 1
        if a.limit and built >= a.limit:
            break
    print(f"built {built}")


if __name__ == "__main__":
    main()
