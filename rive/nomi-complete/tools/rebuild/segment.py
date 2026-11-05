"""Step 1: semantic segmentation of the mother into rig parts.

Every pixel of mother-v2 with alpha > 0 gets exactly one part label.
- Old rig parts whose pixels are semantically clean (eyes, brows, nose, lips, fingers, cuffs, belt,
  badge, pouch, shoes, socks, thigh strap, hem ribbons, hair clip / bow / ornament) are kept as-is.
- Everything else is re-split by colour class + body geometry into seeds, and the remaining
  (line art / anti-aliased / ambiguous) pixels are grown in with a watershed on the image gradient.

usage: segment.py <owner.npz> <mother-v2.png> <out labels.npz> <preview.png>
"""
import sys
import numpy as np
import cv2
from geometry import J, H, W, poly, segdist, capsule_chain, FACE_POLY, NECK_POLY, TORSO_POLY

owner_npz, mother, out, prev = sys.argv[1:5]
z = np.load(owner_npz)
own = z['owner']
names = [str(n) for n in z['names']]
M = cv2.imread(mother, cv2.IMREAD_UNCHANGED)
bgr = M[..., :3]
A = M[..., 3]
oname = np.array([n[:-4] if n.endswith('.png') else n for n in names] + [''], dtype=object)
on = oname[np.clip(own, 0, len(names))]
on[A == 0] = ''

KEEP ={n: n for n in [
    'brow-l', 'brow-r', 'hair-clip', 'hair-bow', 'hair-ornament-l',
    'eye-l-lash', 'eye-l-lid', 'eye-l-hl', 'eye-l-iris', 'eye-l-sclera',
    'eye-r-lash', 'eye-r-lid', 'eye-r-hl', 'eye-r-iris', 'eye-r-sclera',
    'arm-l-cuff', 'arm-r-cuff', 'belt-band', 'belt-id', 'belt-pouch', 'thigh-strap',
    'shoe-l', 'shoe-r', 'sock-l', 'sock-r', 'hem-ribbon-l', 'hem-ribbon-r']}
KEEP.update({'head-nose': 'nose', 'head-mouth': 'lips'})
for side in 'lr':
    for f in ['thumb', 'index', 'middle', 'ring', 'little', 'web', 'palm']:
        KEEP[f'hand-{side}-{f}'] = f'hand-{side}-{f}'

lab = np.full((H, W), '', dtype=object)
fixed = np.zeros((H, W), bool)
for o, n in KEEP.items():
    m = on == o
    lab[m] = n
    fixed |= m
free = (A > 0) & ~fixed

# colour classes
L_, a_, b_ = [c.astype(int) for c in cv2.split(cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB))]
a_ -= 128
b_ -= 128
h_, s_, v_ = [c.astype(int) for c in cv2.split(cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV))]
skin = (L_ > 150) & (a_ > 4) & (a_ < 34) & (b_ > 4) & (b_ < 34) & (s_ < 120)
white = (L_ > 195) & (np.abs(a_) < 8) & (np.abs(b_) < 10)
orange = (s_ > 120) & (h_ >= 5) & (h_ <= 22) & (v_ > 150)
dark = v_ < 80
brown = ~dark & (L_ < 150) & (h_ <= 25) & ~orange
yy, xx = np.mgrid[0:H, 0:W]

FACE = poly(FACE_POLY)
NECK = poly(NECK_POLY)
TORSO = poly(TORSO_POLY)
dl = np.minimum(segdist(J['shoulder_l'], J['elbow_l']), segdist(J['elbow_l'], J['wrist_l']))
dr = np.minimum(segdist(J['shoulder_r'], J['elbow_r']), segdist(J['elbow_r'], J['wrist_r']))
dtor = segdist(J['neck_base'], J['pelvis'])
HEAD_ELL = ((xx - 507) / 92.0) ** 2 + ((yy - 118) / 100.0) ** 2 < 1

seed = np.full((H, W), '', dtype=object)
def put(mask, name):
    seed[mask & free & (seed == '')] = name

# --- head
hairc = brown | dark | orange
put(skin & FACE, 'face')
put(hairc & HEAD_ELL & (yy < 165) & ~FACE, 'hair-front')
put(hairc & FACE & (yy < 178), 'hair-front')
CHOKER = (yy > 234) & (yy < 268) & (xx > 460) & (xx < 568)
PENDANT = (yy >= 262) & (yy < 306) & (xx > 488) & (xx < 528)
put(~skin & ~orange & ~brown & CHOKER & (xx > 468) & (xx < 560), 'choker')
put((orange | dark | brown) & PENDANT, 'choker')
put(hairc & (yy < 330) & (xx < 507) & ~TORSO & ~NECK & ~CHOKER & (dl > 30), 'hair-side-l')
put(hairc & (yy < 330) & (xx >= 507) & ~TORSO & ~NECK & ~CHOKER & (dr > 30), 'hair-side-r')
# --- neck
put(skin & NECK & ~FACE, 'neck')
# --- arms (skin near the arm line, above the cuff)
put(skin & (dl < 34) & (yy < 745), 'arm-l-skin')
put(skin & (dr < 34) & (yy < 745), 'arm-r-skin')
put((white | skin) & (dl < 30) & (yy < 400), 'arm-l-skin')
put((white | skin) & (dr < 30) & (yy < 400), 'arm-r-skin')
# --- legs
LEGCAP_L = capsule_chain([J['hip_l'], J['knee_l'], J['ankle_l']], [70, 52, 40])
LEGCAP_R = capsule_chain([J['hip_r'], J['knee_r'], J['ankle_r']], [70, 52, 40])
put(LEGCAP_L & (yy >= 715) & (yy < 1215) & (xx < 512), 'leg-l')
put(LEGCAP_R & (yy >= 715) & (yy < 1215) & (xx >= 512), 'leg-r')
legs = skin & (yy > 690)
put(legs & (xx < 512), 'leg-l')
put(legs & (xx >= 512), 'leg-r')
# --- torso skin
put(skin & TORSO & (yy < 700), 'chest')
# orange coat lining visible next to the tank / shorts
put(orange & TORSO & (yy >= 262) & (xx < 428), 'coat-front-l')
put(orange & TORSO & (yy >= 262) & (xx > 588), 'coat-front-r')
# --- tank: halter straps (dark) + everything non-skin in the tank body (logo included)
put(dark & TORSO & (yy >= 262) & (yy < 492), 'tank')
put(~skin & TORSO & (yy >= 330) & (yy < 492), 'tank')
# --- shorts (dark / brown inside the torso below the belt)
put((dark | brown) & TORSO & (yy >= 505) & (yy < 730), 'shorts')
# --- coat: white / orange / dark parts outside the torso
coatpix = (white | orange | dark | brown) & ~TORSO & (yy >= 240) & (yy < 1000) & ~(((LEGCAP_L | LEGCAP_R)) & (yy >= 715))
upper = yy < 405
put(coatpix & upper & (xx < 507) & (dl > 22), 'coat-collar-l')
put(coatpix & upper & (xx >= 507) & (dr > 22), 'coat-collar-r')
# the coat front panels hang on the INNER side of each arm (towards the torso); the puffed sleeve
# reaches far out on the outer side, so split by side of the arm line, not by distance alone
def line_x(pts):
    ys = np.array([p[1] for p in pts], float)
    xs = np.array([p[0] for p in pts], float)
    return np.interp(yy, ys, xs)
inner_l = xx > line_x([J['shoulder_l'], J['elbow_l'], J['wrist_l']]) + 28
inner_r = xx < line_x([J['shoulder_r'], J['elbow_r'], J['wrist_r']]) - 28
front_l = coatpix & ~upper & (xx < 507) & inner_l & ~white
front_r = coatpix & ~upper & (xx >= 507) & inner_r & ~white
put(front_l & (dl >= 40), 'coat-front-l')
put(front_r & (dr >= 40), 'coat-front-r')
put(coatpix & ~upper & (xx < 507), 'sleeve-l')
put(coatpix & ~upper & (xx >= 507), 'sleeve-r')

cats = sorted(set(seed[seed != ''].tolist()) | set(KEEP.values()))
idx = {c: i + 1 for i, c in enumerate(cats)}
mk = np.zeros((H, W), np.int32)
for c, i in idx.items():
    mk[(seed == c) | (lab == c)] = i
mk[A == 0] = len(cats) + 1
ws = cv2.watershed(cv2.GaussianBlur(bgr, (3, 3), 0), mk)
inv = {i: c for c, i in idx.items()}
grow = free & (seed == '')
for c, i in idx.items():
    lab[free & (seed == c)] = c
    lab[grow & (ws == i)] = c
# watershed ridge pixels and isolated specks: nearest labelled pixel
known = lab != ''
_, nl = cv2.distanceTransformWithLabels((~known).astype(np.uint8), cv2.DIST_L2, 5,
                                        labelType=cv2.DIST_LABEL_PIXEL)
ky, kx = np.nonzero(known)
lut = np.zeros(nl.max() + 1, np.int64)
lut[nl[known]] = np.arange(len(ky))
rest = (A > 0) & ~known
ry, rx = np.nonzero(rest)
src = lut[nl[ry, rx]]
lab[ry, rx] = lab[ky[src], kx[src]]
assert not ((A > 0) & (lab == '')).any()

uniq = sorted(set(lab[A > 0].tolist()))
ix = {u: i for i, u in enumerate(uniq)}
Lm = np.full((H, W), -1, np.int16)
for u, i in ix.items():
    Lm[lab == u] = i
np.savez_compressed(out, labels=Lm, names=np.array(uniq))

rng = np.random.default_rng(7)
col = rng.integers(40, 255, (len(uniq), 3)).astype(np.uint8)
v = np.zeros((H, W, 3), np.uint8)
v[Lm >= 0] = col[Lm[Lm >= 0]]
v = (v * 0.7 + bgr * 0.3).astype(np.uint8)
for u, i in ix.items():
    m = Lm == i
    if m.sum() > 400:
        y, x = np.median(np.argwhere(m), 0).astype(int)
        cv2.putText(v, u, (x - 25, y), 0, 0.33, (255, 255, 255), 1)
cv2.imwrite(prev, v)
print(len(uniq), 'parts')
print({u: int((Lm == i).sum()) for u, i in ix.items()})
