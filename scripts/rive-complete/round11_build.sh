#!/usr/bin/env bash
# ROUND11 pipeline = the ROUND10 pipeline (pinned to the ROUND9 state 754f4a0, idempotent) with the ROUND11 generator changes:
#   round10_hand.py : hand pieces carry under-skirts (no gap when the thumb/fingers rotate away; clap seam)
#   round10_fist.py : thumb joints use per-joint progress curves (thumb stays inside the palm width during full.fist)
# Tools / metrics: scripts/rive-complete/round11/ (gapscan, gapmetric, thumbscan, thumbsheet, allclips2, shots11, fistsim, search_thumb)
set -euo pipefail
exec "$(dirname "$0")/round10_build.sh" "$@"
