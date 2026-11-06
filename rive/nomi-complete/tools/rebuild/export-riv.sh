#!/usr/bin/env bash
# Write the scene's .riv without `rive login`: run the live-link server headless and keep the build it pushes.
# The scene has no scripts, so the unsigned build is what the runtime loads. usage: export-riv.sh <out.riv>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
proj="$(cd "$here/../.." && pwd)"
out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
(cd "$proj" && exec rive . --headless-serve >/dev/null 2>&1) &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
uv run -q --with websockets python "$here/livelink_riv.py" "$out"
