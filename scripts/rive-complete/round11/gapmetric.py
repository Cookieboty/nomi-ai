#!/usr/bin/env python3
"""gapmetric.py TAG_A TAG_B [DATA=clap] [DIR=/tmp/gs] [OUT.md]: compares two gapscan.py runs (hand-only coverage masks per frame).
Per frame and screen side (screen-left = x<480, screen-right = x>=480):
  hole  = px of fully enclosed holes of the hand coverage that lie within 8 px of a finger piece (the wrist/cuff end is excluded)
  crack = px of closing(coverage, 7x7)-coverage within 8 px of a finger piece (thin slits <= 6 px, open or closed)
'gap px' reported = hole(frame) - mean hole(rest frames 90-96) of the same version (positive = gap opened by the animation)."""
import glob, re, sys
import cv2, numpy as np
def load(f): return np.unpackbits(np.load(f))[:1300 * 960].reshape(1300, 960).astype(bool)
def sides(m):
    m = m.copy(); m[:300] = False; m[720:] = False
    a, b = m.copy(), m.copy(); a[:, 480:] = False; b[:, :480] = False
    return a, b
def stats(tag, data, d):
    rows = []
    for f in sorted(x for x in glob.glob(f'{d}/{tag}-{data}-f*.npy') if '.fing' not in x):
        fr = int(re.search(r'-f(\d+)\.npy', f).group(1))
        m = load(f); mf = load(f.replace('.npy', '.fing.npy'))
        r = [fr]
        for mm, ff in zip(sides(m), sides(mf)):
            mm8 = mm.astype(np.uint8)
            pad = np.pad(1 - mm8, 1, constant_values=1).astype(np.uint8); ff_ = pad.copy(); cv2.floodFill(ff_, None, (0, 0), 2)
            hole = ff_[1:-1, 1:-1] == 1
            near = cv2.dilate(ff.astype(np.uint8), np.ones((17, 17), np.uint8)) > 0
            K = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
            cl = cv2.morphologyEx(mm8, cv2.MORPH_CLOSE, K).astype(bool) & ~mm & near
            r += [int((hole & near).sum()), int(cl.sum())]
        rows.append(r)
    return np.array(rows)
if __name__ == '__main__':
    ta, tb = sys.argv[1], sys.argv[2]; data = sys.argv[3] if len(sys.argv) > 3 else 'clap'; d = sys.argv[4] if len(sys.argv) > 4 else '/tmp/gs'
    out = sys.argv[5] if len(sys.argv) > 5 else None
    A, B = stats(ta, data, d), stats(tb, data, d)
    names = ['screen-left', 'screen-right']
    md = [f'# gap metrics, trigger `{data}`: {ta} (before) vs {tb} (after)', '',
          'hole = enclosed hole px within 8px of a finger piece; crack = closing(7x7)-coverage px within 8px of a finger piece; both from hand-only renders.', '',
          '| frame | L hole before | L hole after | L crack before | L crack after | R hole before | R hole after | R crack before | R crack after |', '|---|---|---|---|---|---|---|---|---|']
    for a, b in zip(A, B): md.append(f'| {a[0]} | {a[1]} | {b[1]} | {a[2]} | {b[2]} | {a[3]} | {b[3]} | {a[4]} | {b[4]} |')
    rest = lambda X: X[X[:, 0] >= 90][:, 1:].mean(0)
    ra, rb = rest(A), rest(B)
    sel = lambda X: (X[:, 0] >= 14) & (X[:, 0] <= 72)
    md += ['', '| side | rest hole before | rest hole after | mean gap px f14-72 before | after | max gap px before | after | frames with gap px > 10: before | after |', '|---|---|---|---|---|---|---|---|---|']
    summary = {}
    for k, nm in enumerate(names):
        c = 1 + 2 * k
        ga = A[sel(A), c] - ra[2 * k]; gb = B[sel(B), c] - rb[2 * k]
        md.append(f'| {nm} | {ra[2*k]:.1f} | {rb[2*k]:.1f} | {ga.mean():.1f} | {gb.mean():.1f} | {ga.max():.0f} | {gb.max():.0f} | {(ga>10).sum()}/{len(ga)} | {(gb>10).sum()}/{len(gb)} |')
        summary[nm] = (ga.mean(), gb.mean(), ga.max(), gb.max())
        md.append(f'|  ↳ absolute hole px f14-72 (mean / max) | before {A[sel(A), c].mean():.1f} / {A[sel(A), c].max():.0f} | after {B[sel(B), c].mean():.1f} / {B[sel(B), c].max():.0f} | | | | | | |')
    text = '\n'.join(md); print(text)
    if out: open(out, 'w').write(text)
