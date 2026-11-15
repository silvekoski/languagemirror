#!/usr/bin/env bash
# Load the full text history of every article (no size cap) into the chili DB. Resumable.
set -euo pipefail
. ~/.local/share/cj/lib.sh 2>/dev/null || true
[ -x .venv/bin/python ] || uv sync -q
export DB_HOST=100.73.11.93 DB_PORT=3310
nice .venv/bin/python -m scripts.load_m --max-mb 100000 --skip-meta
cj_mem_report 2>/dev/null || true
