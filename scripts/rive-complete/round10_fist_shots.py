#!/usr/bin/env python3
"""ROUND10 fist validation: round10_fist_shots.py OUTDIR [PROJ]
Renders the `fist` trigger over time, writes close-ups + a contact sheet + fist-metrics.md:
per frame and hand: skin components (must be 1 big piece), skin px outside the REST hull (dilated 3 artboard px) = fingers
poking out of the hand, thin-strand px (skin removed by a 3px opening) = tearing/strings."""
import os, subprocess, sys
import cv2
import numpy as np
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
PROJ = sys.argv[2] if len(sys.argv) > 2 else ROOT + '/rive/nomi-complete'
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
RECT = {'L': (255, 590, 375, 740), 'R': (590, 590, 710, 740)}
FRAMES = [1, 8, 16, 22, 28, 36, 44, 58, 66, 72]

def shot(fr, data=None):
    cmd = ['rive', PROJ, '--screenshot=/tmp/_fs.png', f'--advance={fr}'] + ([f'--data={data}=1'] if data else [])
    subprocess.run(cmd, env=env, check=True, capture_output=True)
    im = Image.open('/tmp/_fs.png').convert('RGBA'); bg = Image.new('RGBA', im.size, (30, 30, 30, 255)); bg.alpha_composite(im); return bg.convert('RGB')

def skin(im):
    X = np.array(im).astype(int); r, g, b = X[..., 0], X[..., 1], X[..., 2]
    return ((r > 190) & (r - g > 10) & (r - g < 80) & (g > b - 5) & (g > 110)).astype(np.uint8)

if __name__ == '__main__':
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    rows = ['| frame | hand | skin px (idle -> fist) | pieces >=30px (idle -> fist) | outside idle hull px | thin-strand px (idle -> fist) |', '|---|---|---|---|---|---|']
    tiles = []
    worst = {'out': 0, 'dthin': -999, 'dpieces': -999}

    def metrics(m):
        n, lab, st, _ = cv2.connectedComponentsWithStats(cv2.dilate(m, np.ones((3, 3), np.uint8)))
        pieces = sum(1 for i in range(1, n) if st[i, 4] >= 30)
        op = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        return int(m.sum()), pieces, int(m.sum() - op.sum())

    for fr in FRAMES:
        idle = shot(fr)                      # same frame of the looping idle layer = this frame's REST pose (breathing included)
        im = shot(fr, 'fist')
        row = []
        for k, (x0, y0, x1, y1) in RECT.items():
            mi = skin(idle)[y0:y1, x0:x1]; mi[:12] = 0
            mf = skin(im)[y0:y1, x0:x1]; mf[:12] = 0
            cn, _ = cv2.findContours(mi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            h = cv2.convexHull(np.concatenate(cn)); hm = np.zeros_like(mi); cv2.fillPoly(hm, [h], 1)
            hull = cv2.dilate(hm, np.ones((7, 7), np.uint8))
            outside = int(((mf > 0) & (hull == 0)).sum())
            si, pi, ti = metrics(mi); sf, pf, tf = metrics(mf)
            rows.append(f'| {fr} | {k} | {si} -> {sf} | {pi} -> {pf} | {outside} | {ti} -> {tf} |')
            worst = {'out': max(worst['out'], outside), 'dthin': max(worst['dthin'], tf - ti), 'dpieces': max(worst['dpieces'], pf - pi)}
            c = im.crop((x0, y0 + 20, x1, y1 - 10)); row.append(c.resize((c.width * 4, c.height * 4), Image.LANCZOS))
        t = Image.new('RGB', (row[0].width * 2 + 10, row[0].height), (90, 90, 90)); t.paste(row[0], (0, 0)); t.paste(row[1], (row[0].width + 10, 0)); tiles.append((fr, t))
        if fr in (16, 28, 44): t.save(f'{out}/fist-closeup-f{fr:03d}.png')
        if fr == 1: idle.crop((255, 590, 710, 740)).save(f'{out}/fist-rest-ref.png')
    # contact sheet: 5 per row, scaled 1/2
    th = [t.resize((t.width // 2, t.height // 2), Image.LANCZOS) for _, t in tiles]
    W, H = th[0].size; cols = 5
    sheet = Image.new('RGB', (cols * (W + 8), 2 * (H + 8)), (60, 60, 60))
    for i, t in enumerate(th): sheet.paste(t, ((i % cols) * (W + 8), (i // cols) * (H + 8)))
    sheet.save(f'{out}/fist-contact-sheet.png')
    md = ['# fist 验证指标 (artboard px, 渲染自 --data=fist=1)', '', f'最差值: 出手外(静止包络外 3px)像素 {worst["out"]}, 细丝像素增量 {worst["dthin"]}, >=30px 碎片数增量 {worst["dpieces"]}', ''] + rows
    open(f'{out}/fist-metrics.md', 'w').write('\n'.join(md)); print('\n'.join(md))
