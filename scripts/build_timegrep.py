"""Time Grep precompute (idempotent):
  viz_timegrep_pages  - articles whose text history is in `article` (the article picker), with version counts
  viz_timegrep_cache  - JSON results of the preset searches (the API also writes through to it)
    uv run python -m scripts.build_timegrep [--pages-only] [--refresh]
"""
import sys, time
from app.db import rows
from app import timegrep as tg

GREP_PRESETS = [(1256, "105 päivää"), (1150, "vapaussota"), (1275, "diktaattori"), (6021, "valkoinen kenraali")]
WIKI_PRESETS = ["vapaussota", "sisällissota", "Mannerheim", "Kekkonen"]


def build_pages():
    if "--refresh" in sys.argv:
        rows("DROP TABLE IF EXISTS viz_timegrep_cache")
    rows("""CREATE TABLE IF NOT EXISTS viz_timegrep_cache (
              k VARCHAR(255) PRIMARY KEY, body MEDIUMBLOB NOT NULL, built DATETIME NOT NULL)""")
    rows("""CREATE TABLE IF NOT EXISTS viz_timegrep_pages (
              page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255) NOT NULL, versions INT NOT NULL,
              KEY (title))""")
    t = time.time()
    rows("""REPLACE INTO viz_timegrep_pages (page_id, title, versions)
            SELECT h.page_id, COALESCE(cur.title, h.title), h.n
            FROM (SELECT page_id, MAX(title) title, COUNT(*) n FROM article FOR SYSTEM_TIME ALL GROUP BY page_id) h
            LEFT JOIN article cur ON cur.page_id = h.page_id""")
    print("pages", rows("SELECT COUNT(*) n FROM viz_timegrep_pages")[0]["n"], round(time.time() - t, 1), "s", flush=True)


def warm(refresh):
    for pid, q in GREP_PRESETS:
        k = f"grep:{pid}:{q}"
        if refresh:
            rows("DELETE FROM viz_timegrep_cache WHERE k=%s", (k,))
        t = time.time()
        try:
            body, src = tg.cached(k, lambda: tg.grep_article(pid, q))
            print(k, src, body["stats"], round(time.time() - t, 1), flush=True)
        except tg.UserError as e:
            print(k, "ERROR", e, flush=True)
    for q in WIKI_PRESETS:
        k = f"wiki:{q.lower()}"
        if refresh:
            rows("DELETE FROM viz_timegrep_cache WHERE k=%s", (k,))
        t = time.time()
        body, src = tg.cached(k, lambda: tg.grep_wiki(q))
        print(k, src, [s["n"] for s in body["snapshots"]], body["candidates"], body["candidates_total"],
              round(time.time() - t, 1), flush=True)


if __name__ == "__main__":
    build_pages()
    if "--pages-only" not in sys.argv:
        warm("--refresh" in sys.argv)
