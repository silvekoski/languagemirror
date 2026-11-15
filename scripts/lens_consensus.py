"""Kielipeili, step 5: consensus scores, conflicts and source checks for every loaded article
(and citations for the 9 curated articles first). Loads extra articles given on the command line.
    uv run python -m scripts.lens_consensus ["Stepan Bandera" "et:Harald Nugiseks" ...] [--only-load]"""
import sys

from app import lens_engine as E


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    E.ensure_tables()
    print("citations attached:", E.backfill_refs(), flush=True)
    job = {"id": "cli", "state": "running"}
    for text in args:
        E.load_article(job, text)
    if "--only-load" in sys.argv:
        return
    done = {r["topic"] for r in E.q("SELECT topic FROM lens_factcheck")}
    for t in [r["topic"] for r in E.q("SELECT topic FROM lens_topic")]:
        if t not in done:
            E.score_topic(job, t)


if __name__ == "__main__":
    main()
