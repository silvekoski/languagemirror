# Wikipedia Through Time (Junction 2026, MariaDB challenge)

Hackathon project, built fast: demos first, then the product. See README.md for the data and setup.

- MariaDB 12.3.3 runs on chili as Slurm job `wt-db` (scripts/chili_db.sh, datadir /bulk/shared/wikitime on
  the HDD), reached from the laptop through `scripts/db_tunnel.sh` on 127.0.0.1:3310 (db/user/password
  `wikitime`). Already loaded; never drop or reload tables. SQL shell: `podman exec -i wikitime-db mariadb
  -uwikitime -pwikitime wikitime` (that local container is only a client shim). Never start a local DB.
- The app also runs on chili (job `wt-app`, scripts/chili_app.sh, http://100.73.11.93:8300); push code with
  scripts/sync_chili.sh. Query embedder: job `wt-embedsrv` (scripts/embed_server.py, :8765, bge-m3).
- Python via uv (`uv run ...`), driver PyMySQL (`wikitime/db.py: connect()`, sets time_zone UTC).
  Add deps with `uv add`.
- Server: `uv run python -m app.server` (Flask, port 8000). One blueprint per demo in `app/<name>.py`
  exposing `bp`, API under `/api/<name>/`; pages are static files in `web/` (plain HTML + ES modules
  from CDN with pinned versions: d3@7.9.0, three@0.170.0; no build step). `app/db.py: rows(sql, params)`.
- Tables: `revision` (metadata of all 862k versions: ts UTC, user, anonymous, bytes, delta, is_revert,
  comment, has_text), `article` (SYSTEM VERSIONED full wikitext of all 862,076 versions; history rows
  carry Wikipedia's real edit times; query with `FOR SYSTEM_TIME AS OF TIMESTAMP %s` / `ALL`),
  `article_vector_history` (SYSTEM VERSIONED bge-m3 vectors of yearly snapshots, VECTOR INDEX), `current_article`
  (fi/sv/en Markdown, FULLTEXT), `article_vector` (VECTOR(1024) bge-m3), `category_link`,
  `article_category`. Finnish Wikipedia links: `https://fi.wikipedia.org/?curid=<page_id>`, `?oldid=<rev_id>`.
- Vector search: keep `ORDER BY VEC_DISTANCE_COSINE(...) LIMIT k` in a subquery, join afterwards
  (otherwise the index isn't used).
- This laptop is small (i3, 15 GB RAM, ~8 GB free disk): no heavy compute, no big downloads.
- `ref/` holds MariaDB's reference repos (read-only, MIT); `data/` is gitignored.
