#!/usr/bin/env python3
"""allclips2.py A_PROJ B_PROJ OUT.md [frames=36]: every trigger at the given frames, full-frame diff A vs B.
Hand zone = (hand-only render of A or B, background-subtracted) dilated by 12px.  Reports diff px inside / outside the hand zone."""
import os, re, subprocess, sys
import numpy as np, cv2
from PIL import Image
from multiprocessing import Pool
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
A, B, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
FRAMES = [int(x) for x in (sys.argv[4] if len(sys.argv) > 4 else '36').split(',')]
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
H = os.path.dirname(__file__) + '/handonly.py'
for p, d in ((A, '/tmp/_ac_hA'), (B, '/tmp/_ac_hB'), (A, '/tmp/_ac_nA')):
    subprocess.run(['python3', H, p, d] + ([r'NO_MATCH_XYZ'] if d.endswith('nA') else []), check=True)
names = re.findall(r'<ViewModelPropertyTrigger name="([^"]+)"', open(B + '/scene.rml').read())
def shot(p, n, fr, path):
    subprocess.run(['rive', p, f'--screenshot={path}', f'--advance={fr}', f'--data={n}=1'], env=env, check=True, capture_output=True)
    return np.array(Image.open(path).convert('RGB')).astype(int)
def one(args):
    n, fr = args
    try:
        t = f'/tmp/_ac_{n}_{fr}'
        a = shot(A, n, fr, t + 'a.png'); b = shot(B, n, fr, t + 'b.png')
        ha = shot('/tmp/_ac_hA', n, fr, t + 'ha.png'); hb = shot('/tmp/_ac_hB', n, fr, t + 'hb.png'); base = shot('/tmp/_ac_nA', n, fr, t + 'n.png')
        zone = ((np.abs(ha - base).sum(2) > 24) | (np.abs(hb - base).sum(2) > 24)).astype(np.uint8)
        zone = cv2.dilate(zone, np.ones((25, 25), np.uint8)) > 0
        d = np.abs(a - b).sum(2) > 40
        ys, xs = np.where(d)
        return n, fr, int(d.sum()), int((d & zone).sum()), int((d & ~zone).sum()), (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None
    except Exception as e:
        return n, fr, -1, -1, -1, str(e)[:80]
if __name__ == '__main__':
    jobs = [(n, fr) for n in names for fr in FRAMES]
    with Pool(4) as p: res = p.map(one, jobs)
    md = [f'# {len(names)} 个 trigger @ f{",".join(map(str, FRAMES))}: A={A.split("/rive/")[0]} vs B=工作区, 全帧差异 (>40/765)', '',
          '手部区域 = 两版本手部（仅渲染手指/掌片，减背景）并集外扩 12px。', '', '| trigger | frame | diff px 总 | 手部区内 | 手部区外 | bbox |', '|---|---|---|---|---|---|']
    for n, fr, t, i, o, bb in res: md.append(f'| {n} | {fr} | {t} | {i} | {o} | {bb} |')
    out = sum(r[4] for r in res if r[4] > 0)
    md += ['', f'手部区外差异像素合计: **{out}**；最大单 clip 手部区外: {max(r[4] for r in res)}']
    open(OUT, 'w').write('\n'.join(md)); print('\n'.join(md))
