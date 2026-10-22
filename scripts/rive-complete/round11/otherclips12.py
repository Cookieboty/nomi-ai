#!/usr/bin/env python3
"""otherclips12.py BEFORE_PROJ AFTER_PROJ OUTDIR : finger-clip web/hole check (R12).
Needs /tmp/_ac_hA (hand-only BEFORE), /tmp/_ac_hB (hand-only AFTER), /tmp/_ac_nA (no hands) made by allclips2.py/handonly.py.
For each clip & frame: enclosed hole px (<=300 px, flood-fill of hand-only coverage, y 300..720) before vs after; crop around hands, before|after, 5x."""
import os, subprocess, sys
import numpy as np, cv2
from PIL import Image, ImageDraw
from multiprocessing import Pool
B, A, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
CLIPS = ['wave', 'hello', 'poke', 'ok', 'peace', 'thumbs_up', 'explain', 'fist_pump']
FR = [18, 30, 42, 54, 66]
def shot(p, n, fr):
    path = f'/tmp/_oc_{os.path.basename(p.rstrip("/"))}_{abs(hash(p))%9999}_{n}_{fr}.png'
    subprocess.run(['rive', p, f'--screenshot={path}', f'--advance={fr}', f'--data={n}=1'], env=env, check=True, capture_output=True)
    return np.array(Image.open(path).convert('RGB')).astype(int)
def holes(cov):
    c = cov.copy(); c[:300] = 0; c[720:] = 0
    pad = np.pad(1 - c.astype(np.uint8), 1, constant_values=1).astype(np.uint8); cv2.floodFill(pad, None, (0, 0), 2)
    h = (pad[1:-1, 1:-1] == 1)
    n, lab, st, _ = cv2.connectedComponentsWithStats(h.astype(np.uint8), connectivity=4)
    keep = np.zeros_like(h)
    for i in range(1, n):
        if st[i, 4] <= 300: keep |= lab == i
    return keep
def one(a):
    n, fr = a
    base = shot('/tmp/_ac_nA', n, fr)
    cov = {}
    for k, p in (('b', '/tmp/_ac_hA'), ('a', '/tmp/_ac_hB')):
        cov[k] = np.abs(shot(p, n, fr) - base).sum(2) > 24
    fb, fa = shot(B, n, fr), shot(A, n, fr)
    hb, ha = holes(cov['b']), holes(cov['a'])
    return n, fr, int(hb.sum()), int(ha.sum()), cov['a'] | cov['b'], fb, fa
if __name__ == '__main__':
    with Pool(4) as p: res = p.map(one, [(n, f) for n in CLIPS for f in FR])
    md = ['# other finger clips: enclosed hole px in hand coverage (before = R11, after = R12)', '', '| clip | frame | holes before | holes after |', '|---|---|---|---|']
    tot = {}
    for n, fr, hb, ha, *_ in res:
        md.append(f'| {n} | {fr} | {hb} | {ha} |'); t = tot.setdefault(n, [0, 0, 0]); t[0] += hb; t[1] += ha; t[2] += 1
    md += ['', '| clip | sum before | sum after |', '|---|---|---|'] + [f'| {n} | {t[0]} | {t[1]} |' for n, t in tot.items()]
    open(f'{OUT}/otherclips-holes.md', 'w').write('\n'.join(md)); print('\n'.join(md))
    # contact sheet per clip: rows = frames, before|after crop of the biggest hand zone(s)
    for n in CLIPS:
        rows = []
        for r in [r for r in res if r[0] == n]:
            _, fr, hb, ha, cov, fb, fa = r
            cov = cv2.dilate(cov.astype(np.uint8), np.ones((15, 15), np.uint8))
            cov[:300] = 0; cov[720:] = 0
            nn, lab, st, _ = cv2.connectedComponentsWithStats(cov)
            if nn < 2: continue
            order = sorted(range(1, nn), key=lambda i: -st[i, 4])[:1]
            i = order[0]; x, y, w, h = st[i, :4]
            x0, y0, x1, y1 = max(x - 6, 0), max(y - 6, 0), x + w + 6, y + h + 6
            S = 4
            def tile(img, t):
                im = Image.fromarray(img[y0:y1, x0:x1].astype(np.uint8)).resize(((x1 - x0) * S, (y1 - y0) * S), Image.LANCZOS)
                d = ImageDraw.Draw(im); d.rectangle((0, 0, 8 * len(t) + 8, 14), fill=(0, 0, 0)); d.text((4, 1), t, fill=(255, 255, 0)); return im
            tb, ta = tile(fb, f'R11 {n} f{fr} holes={hb}'), tile(fa, f'R12 {n} f{fr} holes={ha}')
            t = Image.new('RGB', (tb.width * 2 + 8, tb.height), (90, 90, 90)); t.paste(tb, (0, 0)); t.paste(ta, (tb.width + 8, 0)); rows.append(t)
        if not rows: continue
        W = max(r.width for r in rows); H = sum(r.height + 6 for r in rows)
        sheet = Image.new('RGB', (W, H), (60, 60, 60)); yy = 0
        for r in rows: sheet.paste(r, (0, yy)); yy += r.height + 6
        sheet.save(f'{OUT}/clip-{n}-before-after.png')
