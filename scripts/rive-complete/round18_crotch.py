#!/usr/bin/env python3
"""ROUND18 — crotch / between-the-feet fixes for the leg clips (squat, step).

Findings (REPORT-ROUND18.md):
  1. Crotch "stretch": the R13 shorts mesh blends every vertex below mother y 660 to its thigh, split at the crotch
     line (x 505), ~57 px INBOARD of each hip pivot (448 / 566, y 690).  A knee-out thigh rotation a swings those
     vertices down by ~57*sin(a) and the two thighs pull the seam apart -> a pointed dark wedge under the crotch.
     Tried: handing the crotch weights back to the pelvis (+ dropping leg-skin px hidden under the shorts) - it moved
     the problem: the straight crop cuts of the leg skins at x 503/505 showed as spiky slivers (hop got worse), so it
     was NOT kept.  Kept fix: the squat keeps the knees nearly over the feet (knee-out 0.02 rad instead of 0.055;
     the front-view bend is carried by thigh foreshortening), which removes the wedge at the source.
  2. fullbody-base-no-head-arms.png (the hole-filling backdrop under full.pose) carries a 431 px sliver of the
     mother's floor between the shoes (mother x 509-520, y 1437-1496).  It rides with full.pose, so the squat drop /
     step bob slid it below the planted feet as a dark-orange strand.  Not part of the character: removed (mother
     crop fix; at rest it changes ~380 px of floor smear between the shoes).  Idempotent."""
from __future__ import annotations

import hashlib
import json

import numpy as np
from PIL import Image

import round10_layers as L10

PROJECT = L10.PROJECT
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
BASE = PROJECT / "reference/svg-rig/fullbody-base-no-head-arms.png"
SLIVER = (500, 530, 1380, 1536)   # x0, x1, y0, y1 in mother px


def main():
    a = np.array(Image.open(BASE).convert("RGBA"))
    x0, x1, y0, y1 = SLIVER
    removed = int((a[y0:y1, x0:x1, 3] > 0).sum())
    if removed:
        a[y0:y1, x0:x1] = 0
        Image.fromarray(a).save(BASE)
    lic = json.loads(LICENSE.read_text())
    rel = "reference/svg-rig/fullbody-base-no-head-arms.png"
    e = lic["assets"][rel]
    e.update(sha256=hashlib.sha256(BASE.read_bytes()).hexdigest(), bytes=BASE.stat().st_size)
    if "ROUND18" not in e.get("method", ""):
        e["method"] = (e.get("method", "") + "; ROUND18: mother floor sliver between the shoes removed").lstrip("; ")
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    print(f"ROUND18 crotch/feet: backdrop sliver px removed: {removed}")


if __name__ == "__main__":
    main()
