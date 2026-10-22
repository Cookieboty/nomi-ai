#!/usr/bin/env python3
"""ROUND10 cuff/wrist overdraw detector: round10_overdraw.py OUTDIR [REV]

For every scene Image with a rig-meta box, count how many layers draw an opaque pixel (alpha>=128) on each mother
pixel of the cuff/wrist rectangles, and list the per-pair overlap pixel counts + orange (ribbon-coloured) pixels per layer.
REV = git revision to analyse (default: working tree)."""
import io, json, re, subprocess, sys, os, itertools
import numpy as np
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
SVG = 'rive/nomi-complete/reference/svg-rig/'
RECT = {'l': (250, 660, 400, 760), 'r': (630, 660, 780, 760)}   # x0,y0,x1,y1 mother px (cuff + wrist)

def git(rev, path):
    return subprocess.check_output(['git', 'show', f'{rev}:{path}'], cwd=ROOT)

def rd(rev, path):
    return git(rev, path) if rev else open(f'{ROOT}/{path}', 'rb').read()

def layers(rev):
    s = rd(rev, 'rive/nomi-complete/scene.rml').decode()
    assets = dict((i, f) for f, i in re.findall(r'<ImageAsset name="[^"]*" file="reference/svg-rig/([^"]+)\.png" id="([^"]+)"', s))
    meta = json.loads(rd(rev, SVG + 'rig-meta.json'))['boxes']
    out = []
    for name, aid in re.findall(r'<Image name="([^"]*)" assetId="([^"]*)"', s):
        f = assets.get(aid)
        if f and f in meta and 'stump' not in f and 'shoulder' not in f:
            out.append((name, f, meta[f]))
    return out

def orange(a):
    r, g, b, al = [a[..., i].astype(int) for i in range(4)]
    return (al >= 128) & (r >= 170) & ((g - b) >= 45) & (b * 100 < g * 60)

def run(rev):
    res = {}
    for side, (x0, y0, x1, y1) in RECT.items():
        W, H = x1 - x0, y1 - y0
        masks, ors = {}, {}
        for name, f, box in layers(rev):
            png = Image.open(io.BytesIO(rd(rev, SVG + f + '.png'))).convert('RGBA')
            a = np.array(png)
            m = np.zeros((H, W), bool); o = np.zeros((H, W), bool)
            ys, xs = np.mgrid[0:a.shape[0], 0:a.shape[1]]
            ys2, xs2 = ys + box[1] - y0, xs + box[0] - x0
            ok = (ys2 >= 0) & (ys2 < H) & (xs2 >= 0) & (xs2 < W)
            sel = ok & (a[..., 3] >= 128)
            m[ys2[sel], xs2[sel]] = True
            so = ok & orange(a)
            o[ys2[so], xs2[so]] = True
            if m.sum() >= 15:
                masks[f] = m; ors[f] = o
        res[side] = (masks, ors)
    return res

def report(rev, out, tag):
    res = run(rev)
    md = [f'# {tag}: 护腕/手腕区域重叠绘制统计 ({rev or "working tree"})', '']
    for side in 'lr':
        masks, ors = res[side]
        acc = sum(m.astype(int) for m in masks.values())
        md += [f'## {side.upper()} 侧 rect {RECT[side]}', '', f'不透明像素 {int((acc>0).sum())}, 被绘制 {int(acc.sum())} 次, 平均 {acc.sum()/max((acc>0).sum(),1):.2f}×, 最大 {int(acc.max())}×', '',
              '| 层 | 不透明像素 | 橙色像素 |', '|---|---|---|']
        md += [f'| {f} | {int(m.sum())} | {int(ors[f].sum())} |' for f, m in masks.items()]
        md += ['', '成对重叠像素数 (>=40):', '']
        for (fa, ma), (fb, mb) in itertools.combinations(masks.items(), 2):
            n = int((ma & mb).sum())
            if n >= 40: md.append(f'- {fa} ∩ {fb}: {n}')
        md.append('')
    os.makedirs(out, exist_ok=True)
    open(f'{out}/overdraw-{tag}.md', 'w').write('\n'.join(md))
    print('\n'.join(md))

if __name__ == '__main__':
    out = sys.argv[1]; rev = sys.argv[2] if len(sys.argv) > 2 else None
    report(rev, out, 'before' if rev else 'after')
