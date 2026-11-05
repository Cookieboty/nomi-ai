"""Closed-eye layers cut from the character sheet (reference/sheets/nomi-sheet-parts.png, "眼睛闭上").

The sheet tile is the image-right eye; the image-left eye is its mirror. The line art is keyed off the
sheet's skin by darkness, un-premultiplied, scaled to the mother's eye width and placed on the eye centre.
Two copies per eye: `eye-<s>-closed` (keyed by the blink layers) and `eye-<s>-closed-a` (keyed by
actions), so the two layers never key the same image.
usage: eyes.py <rig dir> <sheet png>"""
import sys, os, json
import numpy as np
import cv2

rig_dir, sheet = sys.argv[1:3]
sh = cv2.imread(sheet).astype(np.float32)
t = sh[1250:1300, 683:772]                      # crease + lash line of the closed eye
skin = np.median(t.reshape(-1, 3), 0)
L = t.mean(2)
a = np.clip((skin.mean() - L) / (skin.mean() - 40), 0, 1) ** 0.9
a[a < 0.06] = 0
col = (t - skin * (1 - a[..., None])) / np.maximum(a[..., None], 1e-3)
spr = np.dstack([np.clip(col, 0, 255), a * 255]).astype(np.float32)
EYE = {'r': dict(cx=545, cy=158, w=48, mirror=False), 'l': dict(cx=465, cy=164, w=44, mirror=True)}
meta_p = os.path.join(rig_dir, 'parts.json')
meta = json.load(open(meta_p))
parts = [p for p in meta['top_first'] if '-closed' not in p['name']]
for s, e in EYE.items():
    img = spr[:, ::-1] if e['mirror'] else spr
    k = e['w'] / img.shape[1]
    im = cv2.resize(img, (round(img.shape[1] * k), round(img.shape[0] * k)), interpolation=cv2.INTER_AREA)
    # premultiplied resize already done on straight colours; re-key tiny alpha
    im = np.clip(im, 0, 255).astype(np.uint8)
    im[im[..., 3] < 8] = 0
    h, w = im.shape[:2]
    lash_row = int(round(32 * k))                # the lash line sits ~32 px down the tile
    x0, y0 = int(e['cx'] - w / 2), int(e['cy'] - lash_row)
    at = next(i for i, p in enumerate(parts) if p['name'].startswith(f'eye-{s}-'))
    for suffix in ('closed', 'closed-a'):
        n = f'eye-{s}-{suffix}'
        cv2.imwrite(os.path.join(rig_dir, 'layers', n + '.png'), im)
        parts.insert(at, dict(name=n, z=None, visible=False, alternate=True, box=[x0, y0, w, h]))
meta['top_first'] = parts
json.dump(meta, open(meta_p, 'w'), indent=1)
print('closed eyes: 4 layers')
