#!/bin/bash
# Browser mode: serve web/ on localhost (camera + web worker need http://, not file://) and open it in Chrome.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8790}"
if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  (nohup python3 "$DIR/serve.py" "$PORT" >"${TMPDIR:-/tmp}/pcb-scope-http.log" 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.2; done
fi
open -a "Google Chrome" "http://localhost:$PORT/"
echo "PCB Scope: http://localhost:$PORT/"
