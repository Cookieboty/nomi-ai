#!/usr/bin/env python3
"""ROUND35e: bake committed tip pixels so clean round13_build.sh reproduces R35c/d manual polish.

Procedural R35a–d leave small residual diffs vs the committed tip (mouth ~1287 gt8,
choker 113 tip-only px, belt left scrap 118, coat-l-front 87 tip-only, head polish).
Those edits were applied by hand after the scripts ran.  This step restores the
committed PNGs + META + DETAIL_LICENSE from scripts/rive-complete/r35-bake/ so a clean
rebuild matches tip byte-for-byte on those assets (and therefore the .riv, modulo
any irreducible scene KeyedObject order noise which keycmp shows as track-identical).
Idempotent: no-op when live shas already match the bake copies.
"""
from __future__ import annotations
import json, shutil
from pathlib import Path
import round35_common as C

BAKE = Path(__file__).resolve().parent / "r35-bake"  # NOT under svg-rig: round10 restores that tree from the R9 pin
ASSETS = ("mouth.png", "choker.png", "head.png", "belt-band.png", "coat-l-front.png")
META_FILES = ("choker-split-r35.json", "coat-badge-clean-r35.json")
LICENSE_BAKE = BAKE / "DETAIL_LICENSE.json"


def main():
    if not BAKE.is_dir():
        raise SystemExit(f"missing bake dir {BAKE}")
    changed = []
    for name in ASSETS:
        src, dst = BAKE / name, C.SVG / name
        if not src.exists():
            raise SystemExit(f"missing bake asset {src}")
        if dst.exists() and C.sha(dst) == C.sha(src):
            continue
        shutil.copy2(src, dst)
        changed.append(name)
    for name in META_FILES:
        src, dst = BAKE / name, C.SVG / name
        if src.read_bytes() != dst.read_bytes() if dst.exists() else True:
            shutil.copy2(src, dst)
            changed.append(name)
    lic_dst = C.ROOT / "rive/nomi-complete/parts/DETAIL_LICENSE.json"
    if LICENSE_BAKE.exists() and (not lic_dst.exists() or LICENSE_BAKE.read_bytes() != lic_dst.read_bytes()):
        shutil.copy2(LICENSE_BAKE, lic_dst)
        changed.append("DETAIL_LICENSE.json")
    # ensure build hook
    C.hook_build("round35_bake_committed.py", "round35_coat_badge.py")
    print("ROUND35e bake", "updated:" if changed else "already match tip", changed or "ok")


if __name__ == "__main__":
    main()
