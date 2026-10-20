#!/usr/bin/env python3
"""ROUND24: close see-through holes that R22's shoulder skinning exposed.

R21 kept the sleeve stumps static beside the torso; they hid two texture
cut-outs that are only meant to sit under an overlay.  Once R22 skinned the
stumps to the upper arm, relative motion opens them:

1. Right waist (wave f030-f072): fullbody-base-no-head-arms.png (full.neutral)
   has a cut-out at PNG x574-593 y479-504 under the belt band, and a 7x7 one at
   x569-575 y464-470 under the coat edge; body-backfill.png did not cover them.
   Raising the arm exposed a 2x12 px slit (screen ~x547 y402-415) between the
   belt-band edge and the coat edge strip plus 2-3 torso-edge dots (~x532 y392).
   -> those enclosed holes of union(neutral, backfill) alpha (4-connectivity,
      not touching the border, picked by SEED) become opaque backfill.
      backfill is the bottom-most layer of full.pose, so only previously
      see-through pixels can change.  Only seeded holes: the union also has
      legit enclosed gaps (between the legs) and overlay rims that would darken.
2. Clap (crossed hands): hand-r-palm.png has an enclosed 6x17 cut-out (PNG
   x23-28 y22-38) that the arm-r cuff covers at rest; the wrist bend in clap
   exposes a 1-2 px sliver at the cuff edge.  -> fill that enclosed hole.

Colour: Telea inpainting from the surrounding opaque pixels.  Idempotent.
"""
import os
import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RIG = os.path.join(HERE, '..', '..', 'rive', 'nomi-complete', 'reference', 'svg-rig')
NEU = os.path.join(RIG, 'fullbody-base-no-head-arms.png')
BF = os.path.join(RIG, 'body-backfill.png')
PALM = os.path.join(RIG, 'hand-r-palm.png')
# PNG px inside each torso cut-out (screen = x*0.846354+46.93, y*0.846354)
BF_SEEDS = [(591, 484), (572, 467)]


def enclosed(alpha_union, seeds=None):
    n, lab = cv2.connectedComponents((~alpha_union).astype(np.uint8), connectivity=4)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])).tolist())
    ids = [i for i in range(1, n) if i not in edge] if seeds is None else \
        sorted({int(lab[y, x]) for x, y in seeds} - edge - {0})
    return np.isin(lab, ids) if ids else np.zeros(lab.shape, bool), len(ids)


def inpaint(rgb, known):
    mask = (~known).astype(np.uint8) * 255
    out = cv2.inpaint(cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2BGR), mask, 3, cv2.INPAINT_TELEA)
    return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


def save_filled(path, img, hole, src_rgb, known, label, k):
    if not hole.any():
        print(f'round24: {label}: already closed')
        return
    fill = inpaint(src_rgb, known)
    img = img.copy()
    img[hole, :3] = fill[hole]
    img[hole, 3] = 255
    Image.fromarray(img).save(path, optimize=True)
    print(f'round24: {label}: filled {int(hole.sum())} px in {k} enclosed hole(s)')


n_img = np.array(Image.open(NEU).convert('RGBA'))
b_img = np.array(Image.open(BF).convert('RGBA'))
union = (n_img[..., 3] > 0) | (b_img[..., 3] > 0)
hole, k = enclosed(union, BF_SEEDS)
src = np.where(n_img[..., 3:] > 0, n_img[..., :3], b_img[..., :3])
save_filled(BF, b_img, hole, src, union & ~hole, 'body-backfill.png', k)

p_img = np.array(Image.open(PALM).convert('RGBA'))
pa = p_img[..., 3] > 0
hole, k = enclosed(pa)
save_filled(PALM, p_img, hole, p_img[..., :3], pa, 'hand-r-palm.png', k)
