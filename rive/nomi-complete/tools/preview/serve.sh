#!/usr/bin/env bash
# Serve the repo root and open the motion preview (uses the app's @rive-app/canvas-lite from node_modules).
# usage: rive/nomi-complete/tools/preview/serve.sh [port]
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
port="${1:-6190}"
url="http://127.0.0.1:${port}/rive/nomi-complete/tools/preview/"
echo "Nomi motion preview: $url  (Ctrl+C to stop)"
( sleep 1; command -v open >/dev/null && open "$url" || true ) &
cd "$root" && exec python3 -m http.server "$port" --bind 127.0.0.1
