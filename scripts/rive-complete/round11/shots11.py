#!/usr/bin/env python3
"""shots11.py BEFORE_PROJ AFTER_PROJ OUTDIR : before/after closeups for ROUND11 (clap hands, fist thumb sequence)."""
import os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw
from multiprocessing import Pool
B, A, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
CLAP = [16, 24, 32, 36, 40, 44, 52, 60, 68]
FIST = list(range(56, 77, 2))
def shot(args):
    proj, data, fr, path = args
    subprocess.run(['rive', proj, f'--screenshot={path}', f'--advance={fr}', f'--data={data}=1'], env=env, check=True, capture_output=True)
    im = Image.open(path).convert('RGBA'); bg = Image.new('RGBA', im.size, (30, 30, 30, 255)); bg.alpha_composite(im)
    bg.convert('RGB').save(path)
jobs = []
for tag, proj in (('before', B), ('after', A)):
    for f in CLAP: jobs.append((proj, 'clap', f, f'/tmp/_s11_{tag}_clap_{f}.png'))
    for f in FIST: jobs.append((proj, 'fist', f, f'/tmp/_s11_{tag}_fist_{f}.png'))
with Pool(4) as p: p.map(shot, jobs)
def lab(im, txt):
    d = ImageDraw.Draw(im); d.rectangle((0, 0, 8 * len(txt) + 8, 14), fill=(0, 0, 0)); d.text((4, 1), txt, fill=(255, 255, 0)); return im
# clap: screen-left hand (clap: hand-r asset) and screen-right hand (hand-l asset), 6x
CL = {'screen-left': (298, 425, 408, 500), 'screen-right': (548, 440, 658, 515)}
SC = 6
def clap_tile(tag, f, k):
    x0, y0, x1, y1 = CL[k]
    im = Image.open(f'/tmp/_s11_{tag}_clap_{f}.png').crop((x0, y0, x1, y1)).resize(((x1 - x0) * SC, (y1 - y0) * SC), Image.LANCZOS)
    return lab(im, f'{tag} clap f{f:03d} {k}')
for f in CLAP:
    rows = []
    for tag in ('before', 'after'):
        l, r = clap_tile(tag, f, 'screen-left'), clap_tile(tag, f, 'screen-right')
        t = Image.new('RGB', (l.width + r.width + 8, l.height), (90, 90, 90)); t.paste(l, (0, 0)); t.paste(r, (l.width + 8, 0)); rows.append(t)
        t.save(f'{OUT}/{tag}-clap-hands-closeup-f{f:03d}.png')
    c = Image.new('RGB', (rows[0].width, rows[0].height * 2 + 8), (90, 90, 90)); c.paste(rows[0], (0, 0)); c.paste(rows[1], (0, rows[0].height + 8))
    c.save(f'{OUT}/compare-clap-f{f:03d}.png')
# clap contact sheet: screen-left hand, before | after per frame (4x)
tiles = []
for f in CLAP:
    x0, y0, x1, y1 = CL['screen-left']
    pair = []
    for tag in ('before', 'after'):
        im = Image.open(f'/tmp/_s11_{tag}_clap_{f}.png').crop((x0, y0, x1, y1)).resize(((x1 - x0) * 4, (y1 - y0) * 4), Image.LANCZOS)
        pair.append(lab(im, f'{tag} f{f}'))
    t = Image.new('RGB', (pair[0].width * 2 + 4, pair[0].height), (90, 90, 90)); t.paste(pair[0], (0, 0)); t.paste(pair[1], (pair[0].width + 4, 0)); tiles.append(t)
W, H = tiles[0].size; cols = 2; rows_n = (len(tiles) + 1) // 2
s = Image.new('RGB', (cols * (W + 6), rows_n * (H + 6)), (60, 60, 60))
for i, t in enumerate(tiles): s.paste(t, ((i % cols) * (W + 6), (i // cols) * (H + 6)))
s.save(f'{OUT}/clap-contact-sheet-screen-left-hand.png')
# fist thumb sequence: both hands, 5x; frames 56..76
FH = {'L': (262, 600, 372, 710), 'R': (596, 600, 706, 710)}
def fist_tile(tag, f):
    parts = []
    for k, (x0, y0, x1, y1) in FH.items():
        im = Image.open(f'/tmp/_s11_{tag}_fist_{f}.png').crop((x0, y0, x1, y1)).resize(((x1 - x0) * 3, (y1 - y0) * 3), Image.LANCZOS)
        parts.append(im)
    t = Image.new('RGB', (parts[0].width * 2 + 4, parts[0].height), (90, 90, 90)); t.paste(parts[0], (0, 0)); t.paste(parts[1], (parts[0].width + 4, 0))
    return lab(t, f'{tag} fist f{f} (L | R)')
for tag in ('before', 'after'):
    tl = [fist_tile(tag, f) for f in FIST]
    W, H = tl[0].size; cols = 3; rows_n = (len(tl) + cols - 1) // cols
    s = Image.new('RGB', (cols * (W + 6), rows_n * (H + 6)), (60, 60, 60))
    for i, t in enumerate(tl): s.paste(t, ((i % cols) * (W + 6), (i // cols) * (H + 6)))
    s.save(f'{OUT}/fist-thumb-contact-sheet-{tag}.png')
    if tag == 'after': s.save(f'{OUT}/fist-thumb-contact-sheet.png')
for f in FIST:
    a, b = fist_tile('before', f), fist_tile('after', f)
    c = Image.new('RGB', (a.width, a.height * 2 + 6), (90, 90, 90)); c.paste(a, (0, 0)); c.paste(b, (0, a.height + 6)); c.save(f'{OUT}/compare-fist-thumb-f{f:03d}.png')
    b.save(f'{OUT}/after-fist-thumb-f{f:03d}.png'); a.save(f'{OUT}/before-fist-thumb-f{f:03d}.png')
print('ok')
