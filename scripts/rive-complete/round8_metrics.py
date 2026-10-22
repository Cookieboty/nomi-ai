#!/usr/bin/env python3
"""meanΔ of a rendered idle frame vs the mother (artboard space), per ROI. usage: round8_metrics.py img1.png [img2.png ...]"""
import sys
import numpy as np
from PIL import Image

S, OX = 0.8463541666666666, 46.666666666666686
mother = Image.open("rive/nomi-complete/source-nomi-master.png").convert("RGBA")
mw, mh = mother.size
# mother in artboard space (960x1300)
mm = mother.resize((round(mw * S), round(mh * S)), Image.LANCZOS)
canvas = Image.new("RGBA", (960, 1300), (246, 239, 232, 255))
bg = Image.new("RGBA", (960, 1300), (0, 0, 0, 0))
bg.paste(mm, (round(OX), 0))
alpha = np.array(bg)[:, :, 3] > 200
canvas.alpha_composite(bg)
M = np.array(canvas.convert("RGB")).astype(float)
rois = {"character": (0, 1300), "head": (0, 300), "tank(src335-480)": (round(335 * S), round(480 * S)),
        "belt+shorts(480-752)": (round(480 * S), round(752 * S)), "legs(752-1262)": (round(752 * S), round(1262 * S)),
        "shoes(1262+)": (round(1262 * S), 1300)}
for p in sys.argv[1:]:
    im = np.array(Image.open(p).convert("RGB").resize((960, 1300))).astype(float)
    d = np.abs(im - M).mean(axis=2)
    out = []
    for k, (y0, y1) in rois.items():
        msk = alpha.copy(); msk[:y0] = False; msk[y1:] = False
        out.append(f"{k}={d[msk].mean():.3f}")
    print(p.split('/')[-1], ' '.join(out))
