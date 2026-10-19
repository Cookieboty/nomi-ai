#!/usr/bin/env bash
# ROUND13 pipeline: ROUND10-12 pipeline (pinned R9 start), then the ROUND13 items.
set -euo pipefail
cd "$(dirname "$0")"
bash round10_build.sh "$@"
python3 round13_hem.py
