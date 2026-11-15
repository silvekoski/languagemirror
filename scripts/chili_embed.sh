#!/usr/bin/env bash
# GPU job on chili: set up .venv-gpu (torch cu128 + sentence-transformers) once, then embed snapshots.
set -euo pipefail
. ~/.local/share/cj/lib.sh 2>/dev/null || true
if [ ! -x .venv-gpu/bin/python ]; then
  uv venv -q --python 3.12 .venv-gpu
  uv pip install -q --python .venv-gpu/bin/python torch --index-url https://download.pytorch.org/whl/cu128
  uv pip install -q --python .venv-gpu/bin/python sentence-transformers pyarrow numpy
fi
.venv-gpu/bin/python - <<'PY'
import torch; print("torch", torch.__version__, "cuda", torch.cuda.is_available())
PY
.venv-gpu/bin/python -m scripts.embed_snapshots "$@"
cj_mem_report 2>/dev/null || true
