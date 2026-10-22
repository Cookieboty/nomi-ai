#!/usr/bin/env python3
"""thumbsheet.py TAG OUT.png f1,f2,... [scale=5]: contact sheet of the hand-only fist renders (rows = frames, L | R) with thumb px tinted
and the rest hull (dilated 3px) drawn as a thin cyan outline.  Needs thumbscan.py output (/tmp/_ts_TAG_<f>a.png, /tmp/ts/*)."""
import sys, numpy as np, cv2
from PIL import Image, ImageDraw
tag, out, frames = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split(',')]
sc = int(sys.argv[4]) if len(sys.argv) > 4 else 4
RECT = {'L': (255, 585, 375, 705), 'R': (590, 585, 710, 705)}
FULL = {'L': (255, 560, 480, 760), 'R': (480, 560, 710, 760)}
cols = 4
tiles = []
for fr in frames:
    row = []
    for k in 'LR':
        a = np.array(Image.open(f'/tmp/_ts_{tag}_{fr}a.png').convert('RGB')).astype(np.uint8)
        fx0, fy0, fx1, fy1 = FULL[k]
        th = np.unpackbits(np.load(f'/tmp/ts/{tag}-{fr}-{k}-thumb.npy'))[:(fy1 - fy0) * (fx1 - fx0)].reshape(fy1 - fy0, fx1 - fx0)
        hull = np.unpackbits(np.load(f'/tmp/ts/{tag}-{fr}-{k}-hull.npy'))[:(fy1 - fy0) * (fx1 - fx0)].reshape(fy1 - fy0, fx1 - fx0)
        full = a.copy()
        sub = full[fy0:fy1, fx0:fx1]
        sub[th > 0] = (sub[th > 0] * 0.55 + np.array([60, 110, 255]) * 0.45).astype(np.uint8)
        x0, y0, x1, y1 = RECT[k]
        crop = cv2.resize(full[y0:y1, x0:x1], None, fx=sc, fy=sc, interpolation=cv2.INTER_NEAREST)
        cn, _ = cv2.findContours(hull.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        for c in cn:
            pts = ((c[:, 0, :] + np.array([fx0 - x0, fy0 - y0])) * sc + sc // 2).astype(np.int32)
            cv2.polylines(crop, [pts], True, (0, 230, 230), 1)
        im = Image.fromarray(crop); ImageDraw.Draw(im).text((4, 2), f'{k} f{fr}', fill=(255, 255, 0))
        row.append(im)
    tiles += row
W, H = tiles[0].size
rows = (len(tiles) + cols - 1) // cols
s = Image.new('RGB', (cols * (W + 4), rows * (H + 4)), (60, 60, 60))
for i, t in enumerate(tiles): s.paste(t, ((i % cols) * (W + 4), (i // cols) * (H + 4)))
s.save(out); print(s.size)
