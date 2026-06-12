#!/usr/bin/env bash
# Start the Reel Studio app (backend + GUI) at http://localhost:8000
set -e
cd "$(dirname "$0")"

VENV="tools/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "First run: creating venv and installing deps (this downloads PyTorch/Demucs models on first analysis)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r tools/requirements.txt
fi

PORT="${PORT:-8000}"
echo "Reel Studio → http://localhost:${PORT}"
exec "$VENV/bin/python" -m uvicorn server.app:app --host 0.0.0.0 --port "$PORT"
