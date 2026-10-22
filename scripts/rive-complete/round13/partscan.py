#!/usr/bin/env python3
"""partscan.py PROJ REGEX "trig:f1,f2;..." OUT.md [SPLIT_X=480]: renders only the Images matching REGEX (others opacity 0,
background-subtracted) and reports per screen side: coverage px, area change vs the rest frame (idle f0), connected
components (8-conn, >=3 px), enclosed hole px (flood fill) -> a tear or a seam opening shows up as extra components/holes."""
import os, re, shutil, subprocess, sys
import numpy as np, cv2
from PIL import Image
from multiprocessing import Pool
P, RX, spec, OUT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
SX = int(sys.argv[5]) if len(sys.argv) > 5 else 480
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'round11', 'handonly.py')
tag = abs(hash((P, RX))) % 10**6
DP, DN = f'/tmp/_ps_{tag}_p', f'/tmp/_ps_{tag}_n'
jobs = [('', 0)]
for part in spec.split(';'):
    t, fs = part.split(':'); jobs += [(t, int(f)) for f in fs.split(',')]
def shot(p, t, f):
    path = f'{p}/_s_{t or "idle"}_{f}.png'
    subprocess.run(['rive', p, f'--screenshot={path}', f'--advance={f}'] + ([f'--data={t}=1'] if t else []), env=env, check=True, capture_output=True)
    return np.array(Image.open(path).convert('RGB')).astype(int)
def one(j):
    t, f = j
    m = np.abs(shot(DP, t, f) - shot(DN, t, f)).sum(2) > 24
    out = []
    for side in (m[:, :SX], m[:, SX:]):
        s8 = side.astype(np.uint8)
        n, lab, st, _ = cv2.connectedComponentsWithStats(s8, connectivity=8)
        comps = int((st[1:, 4] >= 3).sum())
        pad = np.pad(1 - s8, 1, constant_values=1).astype(np.uint8); cv2.floodFill(pad, None, (0, 0), 2)
        out += [int(side.sum()), comps, int((pad[1:-1, 1:-1] == 1).sum())]
    return t, f, out
if __name__ == '__main__':
    for d, rx in ((DP, RX), (DN, 'NO_MATCH_XYZ')):
        shutil.rmtree(d, ignore_errors=True); subprocess.run(['python3', H, P, d, rx], check=True)
    with Pool(4) as pool: res = pool.map(one, jobs)
    r0 = res[0][2]
    md = [f'# partscan `{RX}` in {P}', '', 'per screen side (x<{0} / x>={0}): px, Δpx vs idle f0, components (8-conn, >=3px), enclosed hole px'.format(SX), '',
          '| trigger | frame | L px | L Δ% | L comps | L holes | R px | R Δ% | R comps | R holes |', '|---|---|---|---|---|---|---|---|---|---|']
    worst = [0, 0, 0, 0, 0, 0]
    for t, f, o in res:
        dl = 100 * (o[0] - r0[0]) / max(r0[0], 1); dr = 100 * (o[3] - r0[3]) / max(r0[3], 1)
        md.append(f'| {t or "idle"} | {f} | {o[0]} | {dl:+.1f} | {o[1]} | {o[2]} | {o[3]} | {dr:+.1f} | {o[4]} | {o[5]} |')
        worst = [max(worst[0], abs(dl)), max(worst[1], o[1]), max(worst[2], o[2]), max(worst[3], abs(dr)), max(worst[4], o[4]), max(worst[5], o[5])]
    md += ['', f'rest (idle f0): L {r0[0]} px / {r0[1]} comps / {r0[2]} holes; R {r0[3]} px / {r0[4]} comps / {r0[5]} holes',
           f'worst: L |Δ| {worst[0]:.1f}% comps {worst[1]} holes {worst[2]}; R |Δ| {worst[3]:.1f}% comps {worst[4]} holes {worst[5]}']
    open(OUT, 'w').write('\n'.join(md) + '\n'); print('\n'.join(md[-2:]))
    shutil.rmtree(DP, ignore_errors=True); shutil.rmtree(DN, ignore_errors=True)
