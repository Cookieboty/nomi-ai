#!/usr/bin/env bash
# ROUND13 pipeline: ROUND10-12 pipeline (pinned R9 start), then the ROUND13 items.
set -euo pipefail
cd "$(dirname "$0")"
bash round10_build.sh "$@"
python3 round13_legs.py
python3 round13_hem.py
python3 round13_hair.py
python3 round13_collar.py
python3 round14_eyes.py
python3 round14_brows.py
python3 round14_bangs.py
python3 round17_autoblink.py
python3 round18_crotch.py
python3 round18_motions.py
python3 round19_crotch.py
python3 round19_ribbons.py
python3 round20_hair_follow.py
python3 round20_wave_bent.py
python3 round20_lid.py
python3 round21_arm_fk.py
python3 round21_arm_pivot.py
python3 round22_shoulder_skin.py
python3 round23_cleanup.py
python3 round24_waist_backfill.py
python3 round25_shoulder_pivot.py
python3 round25_shoulder_bone.py
python3 round25_shoulder_cap.py
python3 round26_fingers.py
python3 round26_secondary_skin.py
python3 round26_gait.py
python3 round28_armswing.py
python3 round28_spine_skin.py
python3 round27_coat_split.py
python3 round27_coat_rig.py
python3 round27_coat_motion.py
