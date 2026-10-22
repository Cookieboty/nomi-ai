#!/usr/bin/env python3
"""gapscan.py PROJ TAG DATA f1,f2,... [OUTDIR=/tmp/gs]
Renders the HANDS ONLY (all other Images opacity 0, background subtracted) at the given frames of trigger DATA ('' = idle),
stores hand coverage masks (bool, 960x1300) in OUTDIR/TAG-DATA-fNNN.npy and prints per-frame hole metrics:
 holes5 = px of closing(union,5x5)-union (thin slits/gaps <=4px wide), holesF = px enclosed holes (floodfill)."""
import os, subprocess, sys, numpy as np, cv2
from PIL import Image
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
proj, tag, data, frames = sys.argv[1], sys.argv[2], sys.argv[3], [int(x) for x in sys.argv[4].split(',')]
out = sys.argv[5] if len(sys.argv) > 5 else '/tmp/gs'
os.makedirs(out, exist_ok=True)
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
hd, nd, fd = f'/tmp/_gs_h_{tag}', f'/tmp/_gs_n', f'/tmp/_gs_f_{tag}'
subprocess.run(['python3', os.path.dirname(__file__) + '/handonly.py', proj, hd], check=True)
subprocess.run(['python3', os.path.dirname(__file__) + '/handonly.py', proj, fd, r'full\.hand-[lr]\.(little|ring|middle|index|thumb)\.'], check=True)
if not os.path.exists(nd + '/scene.rml'):
    subprocess.run(['python3', os.path.dirname(__file__) + '/handonly.py', proj, nd, 'NO_MATCH_XYZ'], check=True)
def shot(d, fr, path):
    cmd = ['rive', d, f'--screenshot={path}', f'--advance={fr}'] + ([f'--data={data}=1'] if data else [])
    subprocess.run(cmd, env=env, check=True, capture_output=True)
    return np.array(Image.open(path).convert('RGB')).astype(int)
def one(fr):
    a = shot(hd, fr, f'/tmp/_gs_{tag}_{fr}.png'); b = shot(nd, fr, f'/tmp/_gs_n_{tag}_{fr}.png')
    m = (np.abs(a - b).sum(2) > 24)
    np.save(f'{out}/{tag}-{data or "idle"}-f{fr:03d}.npy', np.packbits(m))
    c = shot(fd, fr, f'/tmp/_gs_{tag}_f{fr}.png')
    mf = (np.abs(c - b).sum(2) > 24)
    np.save(f'{out}/{tag}-{data or "idle"}-f{fr:03d}.fing.npy', np.packbits(mf))
    return fr, m
if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=4) as ex: res = list(ex.map(one, frames))
    for fr, m in res:
        print(fr, 'px', int(m.sum()))
