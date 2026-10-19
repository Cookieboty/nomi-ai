#!/usr/bin/env python3
"""ROUND9 close-ups: round9_shots.py OUTDIR TAG   (idle both hands, wave hand, clap hands, 6x nearest upscale on dark stage)"""
import os, subprocess, sys
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
PROJ = os.path.join(os.environ.get('R9_PROJ', ROOT), 'rive/nomi-complete') if not os.environ.get('R9_PROJ_ABS') else os.environ['R9_PROJ_ABS']
env = dict(os.environ, PATH=os.path.expanduser('~/.rive/bin') + ':' + os.environ['PATH'])
BG = (30, 30, 30, 255)

def render(path, frame, data=None):
    cmd = ['rive', PROJ, f'--screenshot={path}', f'--advance={max(1, frame)}']
    if data: cmd.append(f'--data={data}=1')
    subprocess.run(cmd, env=env, check=True, capture_output=True)
    im = Image.open(path).convert('RGBA'); bg = Image.new('RGBA', im.size, BG); bg.alpha_composite(im)
    return bg.convert('RGB')

def crop(im, box, sc, nearest=False):
    c = im.crop(box); return c.resize((c.width * sc, c.height * sc), Image.NEAREST if nearest else Image.LANCZOS)

if __name__ == '__main__':
    out, tag = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    idle = render('/tmp/_r9_idle.png', 60)
    wave = render('/tmp/_r9_wave.png', 52, 'wave')
    clap = render('/tmp/_r9_clap.png', 40, 'clap')
    idle.save(f'{out}/{tag}-idle-f060-full.png'); wave.save(f'{out}/{tag}-wave-f052-full.png'); clap.save(f'{out}/{tag}-clap-f040-full.png')
    # artboard px: idle hands ~ x 250..380 / 570..720, y 600..800
    l = crop(idle, (255, 590, 375, 740), 6); r = crop(idle, (590, 590, 710, 740), 6)
    sheet = Image.new('RGB', (l.width + r.width + 10, l.height), (80, 80, 80)); sheet.paste(l, (0, 0)); sheet.paste(r, (l.width + 10, 0))
    sheet.save(f'{out}/{tag}-idle-hands-closeup.png')
    crop(wave, (800, 20, 960, 330), 4).save(f'{out}/{tag}-wave-hand-closeup.png')
    crop(clap, (250, 380, 700, 540), 3).save(f'{out}/{tag}-clap-hands-closeup.png')
