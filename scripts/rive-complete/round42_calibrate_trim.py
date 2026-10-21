#!/usr/bin/env python3
"""ROUND42 calibration (offline, not in build): render rest with the split head, diff against the R41 rest
render (HEAD scene), map differing screen px back to head.png texels and add them to
head-split-r42-trim.png so backfill texels that are visible at rest get dropped.  Repeat until stable.
usage: round42_calibrate_trim.py R41_IDLE_PNG NEW_IDLE_PNG"""
import sys, numpy as np, cv2
from PIL import Image
import round10_layers as L10
import round41_head_yaw_rig as R41

P = L10.ROOT / "scripts/rive-complete/head-split-r42-trim.png"
a = np.array(Image.open(sys.argv[1]).convert("RGB")).astype(int)
b = np.array(Image.open(sys.argv[2]).convert("RGB")).astype(int)
d = np.abs(a - b).max(2) > 2
s = R41.SCENE.read_text()
(kx, ky, bx, by), (W, H) = R41.head_tex_frame(s)
HX, HY = 480.0, 253.9  # full.head world at rest
trim = (np.array(Image.open(P).convert("L")) > 0) if P.exists() else np.zeros((H, W), bool)
ys, xs = np.where(d)
n0 = trim.sum()
for y, x in zip(ys, xs):
    u = (x + 0.5 - HX - bx) / kx; v = (y + 0.5 - HY - by) / ky
    for uu in (int(np.floor(u - 0.6)), int(np.floor(u)), int(np.floor(u + 0.6))):
        for vv in (int(np.floor(v - 0.6)), int(np.floor(v)), int(np.floor(v + 0.6))):
            if 0 <= uu < W and 0 <= vv < H:
                trim[vv, uu] = True
Image.fromarray((trim * 255).astype(np.uint8)).save(P)
print("trim texels", int(n0), "->", int(trim.sum()), "diff px", int(d.sum()))
