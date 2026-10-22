#!/usr/bin/env bash
# ROUND10 pipeline: always starts from the pinned ROUND9 state (754f4a0) of every file it touches.
set -euo pipefail
cd "$(dirname "$0")/../.."
P=rive/nomi-complete
git restore --source=754f4a0 --worktree -- $P/scene.rml $P/reference/svg-rig $P/parts/DETAIL_LICENSE.json
cd scripts/rive-complete
python3 round10_layers.py >/dev/null      # cuff/sleeve de-dup, ribbon shards -> hem ribbon
python3 round10_scene.py                  # hem-ribbon image offsets
python3 round10_hand_scene.py             # palm + 5 finger pieces per hand
python3 round10_fist.py "$@"              # full.fist clip + `fist` trigger
