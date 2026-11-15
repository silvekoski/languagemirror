#!/usr/bin/env bash
# The demo app as a Slurm job on chili, next to the DB (scripts/chili_db.sh) and the embedder.
#   cj run -n wt-app -c 4 -m 4G -t 3-00:00 --tag wikitime-app -- bash scripts/chili_app.sh
# Serves http://100.73.11.93:8106 (Tailscale; 8100-8199 is the range shared tailnet users may reach,
# so nixos-1 / junction.bobs.build:3006 can proxy to it). Sync code first: scripts/sync_chili.sh
set -euo pipefail
[ -x .venv/bin/gunicorn ] || uv sync -q
export DB_HOST=100.73.11.93 DB_PORT=3310 EMBED_URL=http://100.73.11.93:8765
exec .venv/bin/gunicorn -w 3 --threads 8 -b 100.73.11.93:8106 -b [fd7a:115c:a1e0::fa39:b5e]:8106 --timeout 120 --access-logfile - app.server:app
