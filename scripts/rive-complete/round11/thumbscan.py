#!/usr/bin/env python3
"""thumbscan.py PROJ TAG f1,f2,... : real renders of the `fist` trigger.  For each frame and hand (L = screen left = hand-l, R = hand-r):
 outT = thumb-piece px outside the REST hull (convex hull of the idle hand render of the same frame, dilated 3 artboard px)
 outA = all-hand px outside that hull,  tip = thumb centroid (x,y) rel. to rest hand centroid (smoothness),  
saves thumb masks for sheets in /tmp/ts/."""
import os, subprocess, sys, numpy as np, cv2, json
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
proj, tag, frames = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split(',')]
data = sys.argv[4] if len(sys.argv) > 4 else 'fist'
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
hd, td, nd, pd = f'/tmp/_ts_h_{tag}', f'/tmp/_ts_t_{tag}', '/tmp/_gs_n', f'/tmp/_ts_p_{tag}'
subprocess.run(['python3', os.path.dirname(__file__) + '/handonly.py', proj, hd], check=True)
subprocess.run(['python3', os.path.dirname(__file__) + '/handonly.py', proj, td, r'full\.hand-[lr]\.thumb\.'], check=True)
subprocess.run(['python3', os.path.dirname(__file__) + '/handonly.py', proj, pd, r'full\.hand-[lr]\.palm\.'], check=True)
if not os.path.exists(nd + '/scene.rml'):
    subprocess.run(['python3', os.path.dirname(__file__) + '/handonly.py', proj, nd, 'NO_MATCH_XYZ'], check=True)
os.makedirs('/tmp/ts', exist_ok=True)
def shot(d, fr, path, dat):
    subprocess.run(['rive', d, f'--screenshot={path}', f'--advance={fr}'] + ([f'--data={dat}=1'] if dat else []), env=env, check=True, capture_output=True)
    return np.array(Image.open(path).convert('RGB')).astype(int)
RECT = {'L': (255, 560, 480, 760), 'R': (480, 560, 710, 760)}
def one(fr):
    p = f'/tmp/_ts_{tag}_{fr}'
    base = shot(nd, fr, p + 'n.png', data); rest = shot(hd, fr, p + 'r.png', None)
    # base without hands differs between idle / data render only by non-hand shapes -> use the matching base for each
    base_i = shot(nd, fr, p + 'ni.png', None)
    allf = shot(hd, fr, p + 'a.png', data); th = shot(td, fr, p + 't.png', data); pal = shot(pd, fr, p + 'p.png', None)
    mp = np.abs(pal - base_i).sum(2) > 24
    mr = np.abs(rest - base_i).sum(2) > 24; ma = np.abs(allf - base).sum(2) > 24; mt = np.abs(th - base).sum(2) > 24
    out = {}
    for k, (x0, y0, x1, y1) in RECT.items():
        r = mr[y0:y1, x0:x1].astype(np.uint8); a = ma[y0:y1, x0:x1]; t = mt[y0:y1, x0:x1]
        cn, _ = cv2.findContours(r, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        hm = np.zeros_like(r); cv2.fillPoly(hm, [cv2.convexHull(np.concatenate(cn))], 1)
        hull = cv2.dilate(hm, np.ones((7, 7), np.uint8))
        ys, xs = np.where(t)
        px = np.where(mp[y0:y1, x0:x1].any(0))[0]; band = np.zeros(t.shape, bool); band[:, max(px.min() - 3, 0):px.max() + 4] = True   # palm width +-3px
        out[k] = dict(sideT=int((t & ~band).sum()), outT=int((t & (hull == 0)).sum()), outA=int((a & (hull == 0)).sum()),
                      tip=[float(xs.mean() + x0), float(ys.mean() + y0)] if len(xs) else None, thumbpx=int(t.sum()))
        np.save(f'/tmp/ts/{tag}-{fr}-{k}-thumb.npy', np.packbits(t)); np.save(f'/tmp/ts/{tag}-{fr}-{k}-hull.npy', np.packbits(hull))
    return fr, out
if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=4) as ex: res = list(ex.map(one, frames))
    json.dump({fr: o for fr, o in res}, open(f'/tmp/ts/{tag}.json', 'w'))
    print('frame | L sideT outT outA centroid | R sideT outT outA centroid')
    for fr, o in res:
        print(fr, *[f"{o[k]['sideT']:3d} {o[k]['outT']:3d} {o[k]['outA']:3d} {tuple(round(v) for v in o[k]['tip']) if o[k]['tip'] else None}" for k in 'LR'], sep=' | ')
    print('max sideT L', max(o['L']['sideT'] for _, o in res), 'R', max(o['R']['sideT'] for _, o in res), '| max outT L', max(o['L']['outT'] for _, o in res), 'R', max(o['R']['outT'] for _, o in res), '| max outA L', max(o['L']['outA'] for _, o in res), 'R', max(o['R']['outA'] for _, o in res))
