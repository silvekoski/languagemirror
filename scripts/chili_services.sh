#!/usr/bin/env bash
# Demo services on chili in ONE Slurm job, through the weekend: the app (gunicorn, :8106, reachable by
# shared tailnet users / junction.bobs.build:3006) and the bge-m3 question embedder (:8765).
#   cj run -n wt-svc -c 4 -m 5G -t 2-12:00 --tag wikitime-app -- bash scripts/chili_services.sh
# MariaDB runs in its own job (scripts/chili_db.sh). If an older embedder still holds :8765, this job
# keeps retrying until the port is free, so a replacement can be started before the old one ends.
set -uo pipefail
uv sync -q   # always: picks up new dependencies (fast when up to date)
export DB_HOST=100.73.11.93 DB_PORT=3310 EMBED_URL=http://100.73.11.93:8765
# Claude credentials for the "Ask" answers: an API key in a private file (chmod 600), never in the repo.
#   ANTHROPIC_API_KEY=sk-ant-...
if [ -f "$HOME/.config/wikitime/anthropic.env" ]; then set -a; . "$HOME/.config/wikitime/anthropic.env"; set +a; fi
(
  until .venv-gpu/bin/python -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', 8765))" 2>/dev/null; do sleep 30; done
  exec .venv-gpu/bin/python -m scripts.embed_server --port 8765 --device cpu
) &
EMB=$!
.venv/bin/gunicorn -w 3 --threads 8 -b 100.73.11.93:8106 -b '[fd7a:115c:a1e0::fa39:b5e]:8106' \
  --timeout 120 --access-logfile - app.server:app &
APP=$!
trap 'kill $EMB $APP 2>/dev/null' TERM INT
wait -n $EMB $APP
kill $EMB $APP 2>/dev/null
