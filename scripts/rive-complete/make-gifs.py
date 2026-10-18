#!/usr/bin/env python3
"""side-by-side GIF: canvas rig (left) vs Rive CLI render (right) at the same timestamps.
usage: make-gifs.py ACTION CANVAS_ACTION  (frames from /workspace/scratch/rc/gif)"""
import sys, glob, os, subprocess
from PIL import Image, ImageDraw
act, cact = sys.argv[1], sys.argv[2]
G = '/workspace/scratch/rc/gif'; OUT = '/workspace/screenshots/nomi-rive-complete/gif'; os.makedirs(OUT, exist_ok=True)
CREAM = (246, 239, 232)
cf = sorted(glob.glob(f'{G}/{cact}/f*.png')); rf = sorted(glob.glob(f'{G}/rive-{act}/*.png'))
n = min(len(cf), len(rf)); H = 700; W = 480; tmp = f'{G}/tmp-{act}'; os.makedirs(tmp, exist_ok=True)
for i in range(n):
    a = Image.open(cf[i]).convert('RGB'); b = Image.open(rf[i]).convert('RGB'); b = b.resize((W, round(b.height * W / b.width)), Image.LANCZOS)
    S = Image.new('RGB', (W * 2 + 4, H), CREAM)
    S.paste(a, (0, 0)); S.paste(b, (W + 4, 0))
    d = ImageDraw.Draw(S); d.text((6, H - 28), 'canvas rig (polish 00b358b)', fill=(60, 60, 60)); d.text((W + 10, H - 28), 'Rive (complete parts, CLI render)', fill=(60, 60, 60))
    d.text((6, H - 14), f't={i * 2 / 60:.2f}s', fill=(60, 60, 60)); d.line([(W + 1, 0), (W + 1, H)], fill=(180, 170, 160), width=2)
    S.save(f'{tmp}/{i:04d}.png')
out = f'{OUT}/{act}-canvas-vs-rive.gif'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '30', '-i', f'{tmp}/%04d.png', '-vf', 'split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', out], check=True)
print(out, os.path.getsize(out) // 1024, 'KB', n, 'frames')
