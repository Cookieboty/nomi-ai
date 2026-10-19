#!/usr/bin/env python3
"""ROUND10 regression shots: finger-keyed clips, ROUND9 tip (extracted to R9_DIR) vs working tree.
round10_regress.py OUTDIR  -> OUTDIR/regress-<clip>.png (before | after, hand-region crop 3x) + prints diff bbox"""
import os, subprocess, sys
import numpy as np
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
CLIPS = [('wave', 52), ('hello', 40), ('poke', 40), ('clap', 40), ('ok', 40), ('explain', 40), ('thumbs_up', 36), ('peace', 36), ('fist_pump', 36)]

def shot(proj, name, fr, path):
    subprocess.run(['rive', proj, f'--screenshot={path}', f'--advance={fr}', f'--data={name}=1'], env=env, check=True, capture_output=True)
    im = Image.open(path).convert('RGBA'); bg = Image.new('RGBA', im.size, (30, 30, 30, 255)); bg.alpha_composite(im); return bg.convert('RGB')

if __name__ == '__main__':
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    before = os.environ.get('R9_DIR', '/tmp/r9') + '/rive/nomi-complete'; after = ROOT + '/rive/nomi-complete'
    for name, fr in CLIPS:
        a = shot(before, name, fr, '/tmp/_rg_a.png'); b = shot(after, name, fr, '/tmp/_rg_b.png')
        A, B = np.array(a).astype(int), np.array(b).astype(int)
        d = np.abs(A - B).sum(2) > 40

        def skin(X):
            r, g, bl = X[..., 0], X[..., 1], X[..., 2]
            return (r > 190) & (r - g > 10) & (r - g < 80) & (g > bl - 5) & (g > 110)
        d &= (skin(A) | skin(B))                       # hand pixels only (hair sway etc. is time dependent)
        d[:150] = False
        import cv2
        n, lab, st, _ = cv2.connectedComponentsWithStats(cv2.dilate(d.astype(np.uint8), np.ones((15, 15), np.uint8)))
        cl = sorted([st[i] for i in range(1, n) if st[i, 4] > 150], key=lambda r: -r[4])[:2]
        if not cl: print(name, 'no hand diff'); continue
        tiles = []
        for x, y, w, h, _ in sorted(cl, key=lambda r: r[0]):
            box = (max(x - 6, 0), max(y - 6, 0), min(x + w + 6, a.width), min(y + h + 6, a.height))
            tiles.append(box)
        sc = 5
        ims = []
        for box in tiles:
            w, h = box[2] - box[0], box[3] - box[1]
            ca, cb = a.crop(box).resize((w * sc, h * sc), Image.LANCZOS), b.crop(box).resize((w * sc, h * sc), Image.LANCZOS)
            t = Image.new('RGB', (w * sc, h * sc * 2 + 6), (90, 90, 90)); t.paste(ca, (0, 0)); t.paste(cb, (0, h * sc + 6)); ims.append(t)
        W = sum(t.width for t in ims) + 10 * (len(ims) - 1); Hh = max(t.height for t in ims)
        s_ = Image.new('RGB', (W, Hh), (60, 60, 60)); x0 = 0
        for t in ims: s_.paste(t, (x0, 0)); x0 += t.width + 10
        s_.save(f'{out}/regress-{name}.png')
        print(name, 'hand boxes', tiles, 'diff px', int(d.sum()))
