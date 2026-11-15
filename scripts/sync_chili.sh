#!/usr/bin/env bash
# Push the working tree (code + baked web/data) to chili; the app job serves it (restart it for Python changes).
cd "$(dirname "$0")/.."
exec rsync -a --exclude .venv --exclude .venv-gpu --exclude ref --exclude data --exclude .git --exclude .claude ./ chili:junction2026/wikipediathroughtime/
