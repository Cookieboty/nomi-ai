#!/usr/bin/env python3
"""ROUND9 per-hand drawn-layer inventory (R8 tip be33278 vs working tree): round9_inventory.py OUTDIR

For every scene Image whose pixels land on a hand, count skin-coloured opaque pixels inside the hand rectangle
(mother px) -> layer list + "times each hand pixel is drawn" (multiplicity)."""
import io, json, re, subprocess, sys, os
import numpy as np
from PIL import Image, ImageDraw
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
SVG = 'rive/nomi-complete/reference/svg-rig/'
RECT = {'l': (270, 722, 362, 840), 'r': (655, 722, 748, 840)}
REV = 'be33278'

def git(rev, path):
    return subprocess.check_output(['git', 'show', f'{rev}:{path}'], cwd=ROOT)

def scene(rev):
    return git(rev, 'rive/nomi-complete/scene.rml').decode() if rev else open(f'{ROOT}/rive/nomi-complete/scene.rml').read()

def layers(rev):
    s = scene(rev)
    assets = dict((i, f) for f, i in re.findall(r'<ImageAsset name="[^"]*" file="reference/svg-rig/([^"]+)\.png" id="([^"]+)"', s))
    meta = json.loads(git(rev, SVG + 'rig-meta.json') if rev else open(f'{ROOT}/{SVG}rig-meta.json').read())['boxes']
    out = []
    for name, aid in re.findall(r'<Image name="([^"]*)" assetId="([^"]*)"', s):
        f = assets.get(aid)
        if f and f in meta: out.append((name, f, meta[f]))
    return out

def skin(a):
    r, g, b, al = [a[..., i].astype(int) for i in range(4)]
    return (al > 128) & (r > 170) & (r - g > 12) & (g > b - 5) & (g > 100) & (b > 70)

def inventory(rev):
    res = {}
    for side in 'lr':
        x0, y0, x1, y1 = RECT[side]
        acc = np.zeros((y1 - y0, x1 - x0), int); rows = []
        for name, f, box in layers(rev):
            bx, by = box[0], box[1]
            png = Image.open(io.BytesIO(git(rev, SVG + f + '.png'))) if rev else Image.open(f'{ROOT}/{SVG}{f}.png')
            a = np.array(png.convert('RGBA')); m = np.zeros((y1 - y0, x1 - x0), bool)
            sk = skin(a)
            ys, xs = np.where(sk)
            ys, xs = ys + by - y0, xs + bx - x0
            ok = (ys >= 0) & (ys < y1 - y0) & (xs >= 0) & (xs < x1 - x0)
            m[ys[ok], xs[ok]] = True
            n = int(m.sum())
            if n >= 15:
                rows.append((name.replace('full.', ''), f, n)); acc += m
        res[side] = (rows, acc)
    return res

if __name__ == '__main__':
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    data = {k: inventory(r) for k, r in (('R8', REV), ('R9', None))}
    md = ['# 每手绘制层清单 (Round 8 be33278 vs Round 9)', '',
          '统计口径: 场景里每个 Image 在手部矩形内的「肤色不透明像素数」; 倍数 = 同一像素被几层重复绘制。', '']
    for side in 'lr':
        for tag in ('R8', 'R9'):
            rows, acc = data[tag][side]
            tot = int((acc > 0).sum()); draws = int(acc.sum())
            md += [f'## {side.upper()} 手 — {tag}: {len(rows)} 个 Image 触及手部, 肤色像素 {tot} 个被绘制 {draws} 次 (平均 {draws / max(tot,1):.2f}×, 最大 {int(acc.max())}×)', '',
                   '| Image | 源 PNG | 手部肤色像素 |', '|---|---|---|']
            md += [f'| {n} | {f}.png | {c} |' for n, f, c in rows]
            md.append('')
    open(f'{out}/layers-per-hand.md', 'w').write('\n'.join(md))
    # picture: multiplicity heatmaps
    sc = 5
    def heat(acc):
        pal = np.array([[30,30,30],[60,160,60],[230,200,40],[240,120,30],[220,40,40],[255,0,255],[255,255,255],[255,255,255],[255,255,255]], np.uint8)
        return Image.fromarray(pal[np.minimum(acc, 8)]).resize((acc.shape[1] * sc, acc.shape[0] * sc), Image.NEAREST)
    tiles = []
    for tag in ('R8', 'R9'):
        for side in 'lr':
            rows, acc = data[tag][side]; h = heat(acc)
            t = Image.new('RGB', (h.width, h.height + 60), (20, 20, 20)); t.paste(h, (0, 60)); d = ImageDraw.Draw(t)
            d.text((6, 4), f'{tag} {side.upper()} hand: {len(rows)} Images, max {int(acc.max())}x overdraw', fill=(255, 255, 255))
            d.text((6, 20), 'green=1x yellow=2x orange=3x red=4x magenta=5x white>=6x', fill=(200, 200, 200)); tiles.append(t)
    W = tiles[0].width + tiles[1].width + 10; Hh = tiles[0].height
    sheet = Image.new('RGB', (W, Hh * 2 + 10), (20, 20, 20))
    sheet.paste(tiles[0], (0, 0)); sheet.paste(tiles[1], (tiles[0].width + 10, 0)); sheet.paste(tiles[2], (0, Hh + 10)); sheet.paste(tiles[3], (tiles[0].width + 10, Hh + 10))
    sheet.save(f'{out}/layers-per-hand-overdraw.png')
    print('\n'.join(md))
