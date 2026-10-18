#!/usr/bin/env python3
"""Rive CLI renders (headless, no GPU): shots.py OUT_DIR ACTION f1,f2,...   -> OUT_DIR/ACTION-fNNN.png (composited on cream)"""
import os, subprocess, sys
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
PROJ = os.path.join(ROOT, 'rive/nomi-complete')
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
CREAM = (246, 239, 232)
def shot(path, action, frame):
    cmd = ['rive', PROJ, f'--screenshot={path}', f'--advance={max(1, frame)}']
    if action != 'idle': cmd.append(f'--data={action}=1')
    subprocess.run(cmd, env=env, check=True, capture_output=True)
    im = Image.open(path).convert('RGBA'); bg = Image.new('RGBA', im.size, CREAM + (255,)); bg.alpha_composite(im)
    bg.convert('RGB').save(path)
if __name__ == '__main__':
    out, action, frames = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split(',')]
    os.makedirs(out, exist_ok=True)
    for f in frames: shot(os.path.join(out, f'{action}-f{f:03d}.png'), action, f)
