"""Step 2: build complete rig layers from the segmentation.

For each part:
  rest pixels  = its pixels in the segmentation (exact mother-v2 values)
  backfill     = the part's full silhouette minus its rest pixels, painted from the part's own colours
                 (inpaint) with a soft edge shade and a line-art outline on painted edges
Backfill is kept only where the pixel is owned by a part drawn ABOVE this one and that owner is fully
opaque, so the rest pose recomposes mother-v2 exactly.

usage: paint.py <seg.npz> <mother-v2.png> <old layers dir> <out dir>
"""
import sys, os, json
import numpy as np
import cv2
from geometry import J, H, W, poly, capsule_chain, FACE_POLY, NECK_POLY, TORSO_POLY

seg_npz, mother, oldlayers, outdir = sys.argv[1:5]
z = np.load(seg_npz)
S = z['labels']
snames = [str(n) for n in z['names']]
M = cv2.imread(mother, cv2.IMREAD_UNCHANGED)
RGB = M[..., :3]
MA = M[..., 3]
old = json.load(open(os.path.join(oldlayers, 'layers.json')))['order_bottom_to_top']
oldbox = {e['name']: e['box'] for e in old if e['box']}

FINGERS = ['thumb', 'index', 'middle', 'ring', 'little']
# draw order, top first
TOP_FIRST = (
    ['hair-clip', 'hair-bow', 'hair-ornament-l', 'hair-front', 'brow-l', 'brow-r'] +
    [f'eye-{s}-{p}' for s in 'lr' for p in ['lash', 'lid', 'hl', 'iris', 'sclera']] +
    ['mouth-viseme-a', 'mouth-viseme-i', 'mouth-viseme-u', 'mouth-viseme-e', 'mouth-viseme-o', 'mouth-viseme-m',
     'face-smile', 'nose', 'lips', 'head-cheek-l', 'head-cheek-c', 'head-cheek-r', 'hair-side-l', 'hair-side-r',
     'face'] +
    [x for s in 'lr' for x in
     [y for f in FINGERS for y in [f'hand-{s}-{f}-p2', f'hand-{s}-{f}-p1', f'hand-{s}-{f}-p0', f'hand-{s}-{f}-meta',
                                    f'hand-{s}-{f}']] +
     [f'hand-{s}-web', f'hand-{s}-palm-meta', f'hand-{s}-palm', f'arm-{s}-cuff', f'sleeve-{s}', f'arm-{s}-skin']] +
    ['hem-ribbon-l', 'hem-ribbon-r', 'belt-pouch', 'belt-id', 'belt-band', 'coat-front-l', 'coat-front-r',
     'thigh-strap', 'shorts', 'choker', 'tank', 'neck', 'chest', 'coat-collar-l', 'coat-collar-r',
     'shoe-l', 'sock-l', 'leg-l', 'shoe-r', 'sock-r', 'leg-r', 'hair-back'])
# hidden alternates the animations switch on (copied unchanged from the old rig)
ALTERNATES = {n for n in TOP_FIRST if n.startswith(('mouth-viseme', 'head-cheek')) or n == 'face-smile'
              or n.endswith(('-p0', '-p1', '-p2', '-meta'))}
KEEP_OLD_CONTENT = {n for n in TOP_FIRST if n.startswith(('eye-', 'brow-', 'hand-', 'hair-clip', 'hair-bow',
                                                          'hair-ornament')) or n in (
    'arm-l-cuff', 'arm-r-cuff', 'belt-band', 'belt-id', 'belt-pouch', 'thigh-strap', 'shoe-l', 'shoe-r',
    'sock-l', 'sock-r', 'hem-ribbon-l', 'hem-ribbon-r')} | ALTERNATES
OLDNAME = {'nose': 'head-nose', 'lips': 'head-mouth'}
KEEP_OLD_CONTENT |= {'nose', 'lips'}

z_of = {n: i for i, n in enumerate(TOP_FIRST)}          # smaller = drawn above
owner = np.full((H, W), 10 ** 6, np.int32)
for i, n in enumerate(snames):
    assert n in z_of, n
    owner[S == i] = z_of[n]
owner[MA == 0] = 10 ** 6


def full_old(name):
    o = OLDNAME.get(name, name)
    p = os.path.join(oldlayers, 'layers', o + '.png')
    if o not in oldbox or not os.path.exists(p):
        return None
    P = cv2.imread(p, cv2.IMREAD_UNCHANGED)
    x, y, w, h = oldbox[o]
    C = np.zeros((H, W, 4), np.uint8)
    C[y:y + h, x:x + w] = P
    return C


def closing(m, r):
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    return cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, k).astype(bool)


def fill_holes(m):
    m8 = m.astype(np.uint8)
    ff = m8.copy()
    pad = np.zeros((H + 2, W + 2), np.uint8)
    cv2.floodFill(ff, pad, (0, 0), 1)
    return m | (ff == 0)


yy, xx = np.mgrid[0:H, 0:W]
hair_parts = [i for i, n in enumerate(snames) if n.startswith('hair-') or n in ('face', 'nose', 'lips', 'brow-l', 'brow-r')
              or n.startswith('eye-')]
HAIR_ALL = np.isin(S, hair_parts)


def silhouette(name, rest):
    if name == 'face':
        # real face shape: an ellipse for the cheeks / forehead hidden under hair, cut at the jaw line
        # (lowest visible face pixel per column; ellipse bottom where the jaw is hidden)
        ell = (((xx - 506) / 61.0) ** 2 + ((yy - 160) / 80.0) ** 2) < 1
        jaw = np.full(W, -1)
        cols = np.nonzero(rest.any(0))[0]
        for c in cols:
            jaw[c] = np.nonzero(rest[:, c])[0].max()
        xs_ = np.arange(W)
        ell_bottom = 160 + 80 * np.sqrt(np.clip(1 - ((xs_ - 506) / 61.0) ** 2, 0, 1))
        known = jaw >= 0
        jl = np.where(known, np.minimum(jaw, ell_bottom), ell_bottom)
        below_jaw = yy > jl[None, :]
        ear = (((xx - 441) / 8.0) ** 2 + ((yy - 168) / 18.0) ** 2) < 1
        return rest | ((ell | ear) & ~below_jaw & (yy > 95))
    if name == 'neck':
        return rest | poly(NECK_POLY)
    if name == 'chest':
        return rest | poly(TORSO_POLY)
    if name == 'arm-l-skin':
        return rest | capsule_chain([J['shoulder_l'], J['elbow_l'], J['wrist_l']], [33, 26, 18])
    if name == 'arm-r-skin':
        return rest | capsule_chain([J['shoulder_r'], J['elbow_r'], J['wrist_r']], [33, 26, 18])
    if name in ('leg-l', 'leg-r'):
        # only complete the thigh under the shorts; beside the visible leg there is nothing to invent
        hip = (452, 640) if name == 'leg-l' else (563, 640)
        knee = J['knee_l'] if name == 'leg-l' else J['knee_r']
        return rest | (capsule_chain([hip, knee], [58, 45]) & (yy < 728) & poly(TORSO_POLY))
    if name == 'tank':
        return closing(rest, 15) | (poly(TORSO_POLY) & (yy >= 340) & (yy < 506))
    if name == 'shorts':
        return closing(rest, 15) | (poly(TORSO_POLY) & (yy >= 498) & (yy < 722))
    if name == 'hair-back':
        m = cv2.dilate(HAIR_ALL.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
        m = fill_holes(closing(m, 25)) & (yy < 300)
        return m
    if name.startswith(('sleeve-', 'coat-')):
        return closing(rest, 14)
    return rest


def paint(name, rest, sil, colour_src):
    """Smooth fill of sil from the colours at colour_src (normalised Gaussian convolution, two scales,
    median colour as the far fallback)."""
    if not colour_src.any():
        return None
    er = cv2.erode(colour_src.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    if er.sum() > 200:
        colour_src = er
    k = colour_src.astype(np.float32)
    img = RGB.astype(np.float32) * k[..., None]
    out = np.zeros((H, W, 3), np.float32)
    wsum = np.zeros((H, W), np.float32)
    for sigma, wgt in ((8, 0.6), (24, 0.5), (70, 0.15)):
        num = cv2.GaussianBlur(img, (0, 0), sigma)
        den = cv2.GaussianBlur(k, (0, 0), sigma)
        good = den > 1e-3
        est = np.where(good[..., None], num / np.maximum(den, 1e-6)[..., None], 0)
        conf = np.clip(den * 2.5, 0, 1) * wgt
        out += est * conf[..., None]
        wsum += conf
    med = np.median(RGB[colour_src].astype(np.float32), 0)
    out = (out + med * 0.02) / (wsum + 0.02)[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)


_L, _a, _b = [c.astype(int) for c in cv2.split(cv2.cvtColor(RGB, cv2.COLOR_BGR2LAB))]
_a -= 128
_b -= 128
_h, _s, _v = [c.astype(int) for c in cv2.split(cv2.cvtColor(RGB, cv2.COLOR_BGR2HSV))]
SKINC = (_L > 150) & (_a > 4) & (_a < 34) & (_b > 4) & (_b < 34) & (_s < 120)
DARKC = _v < 90
HAIRC = (_L < 150) & (_h <= 25) & ~((_s > 120) & (_v > 150))


def colour_ok(name):
    """Which pixels of a part may seed its backfill colour."""
    if skinlike(name):
        return SKINC
    if name in ('tank', 'shorts'):
        return DARKC
    if name == 'hair-back':
        return HAIRC
    return np.ones((H, W), bool)


def blush_layer(name):
    """Anime blush: soft pink ellipse + three short diagonal hatch lines (cheek-c: faint nose band)."""
    C = np.zeros((H, W, 4), np.uint8)
    pink = np.array([150, 140, 240], np.float32)        # BGR
    if name == 'head-cheek-c':
        cx, cy, rx, ry, peak = 506, 188, 30, 6, 0.28
    else:
        cx, cy = (470, 192) if name.endswith('-l') else (547, 188)
        rx, ry, peak = 17, 8, 0.55
    d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    a = np.clip(1 - d, 0, 1) ** 1.5 * peak
    if name != 'head-cheek-c':
        for i in (-1, 0, 1):
            x0 = cx + i * 7
            line = np.zeros((H, W), np.uint8)
            cv2.line(line, (x0 - 3, cy + 4), (x0 + 3, cy - 4), 255, 1, cv2.LINE_AA)
            a = np.maximum(a, line / 255.0 * 0.75)
    C[..., :3] = pink.astype(np.uint8)
    C[..., 3] = np.clip(a * 255, 0, 255).astype(np.uint8)
    C[C[..., 3] == 0] = 0
    return C


def skinlike(name):
    return name in ('face', 'neck', 'chest', 'arm-l-skin', 'arm-r-skin', 'leg-l', 'leg-r')


os.makedirs(os.path.join(outdir, 'layers'), exist_ok=True)
for f in os.listdir(os.path.join(outdir, 'layers')):
    os.remove(os.path.join(outdir, 'layers', f))
parts = []
layers = {}
for name in TOP_FIRST:
    k = z_of[name]
    sidx = snames.index(name) if name in snames else None
    rest = (S == sidx) if sidx is not None else np.zeros((H, W), bool)
    C = np.zeros((H, W, 4), np.uint8)
    if name in KEEP_OLD_CONTENT:
        O = full_old(name)
        if O is None:
            print('missing old content', name)
            continue
        C = O
        if name in ALTERNATES:
            if name.startswith('head-cheek'):
                # the old "cheek" layers were copies of whole face / hair regions; paint real blush
                C = blush_layer(name)
            layers[name] = C
            parts.append(dict(name=name, z=k, visible=False, alternate=True))
            continue
        C[rest, :3] = RGB[rest]
        C[rest, 3] = MA[rest]
    else:
        sil = silhouette(name, rest)
        src = rest & (MA == 255) & colour_ok(name)
        if name == 'hair-back':
            src = np.isin(S, [i for i, n in enumerate(snames) if n.startswith('hair-')]) & (MA == 255) & \
                  ~np.isin(S, [snames.index('hair-bow'), snames.index('hair-clip'), snames.index('hair-ornament-l')]) & \
                  colour_ok('hair-back')
        fill = paint(name, rest, sil, src) if (sil & ~rest).any() else None
        if fill is not None and name == 'face':
            # the face is seen up close (eyes close, hair moves): continue the neighbouring skin locally
            # instead of the wide blur, so the eye sockets match the shading around them
            known8 = (src & cv2.erode(src.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)).astype(np.uint8)
            tel = cv2.inpaint(RGB, (1 - known8), 7, cv2.INPAINT_TELEA)
            tel = cv2.GaussianBlur(tel, (0, 0), 1.5)
            inv_ = sil & ~rest
            fill[inv_] = tel[inv_]
        if fill is not None:
            inv = sil & ~rest
            col = fill.astype(np.float32)
            if skinlike(name) or name == 'hair-back':
                # soft shade towards the painted silhouette edge + a line-art outline on it
                d = cv2.distanceTransform(sil.astype(np.uint8), cv2.DIST_L2, 5)
                col *= (0.90 + 0.10 * np.clip(d / 12.0, 0, 1))[..., None]
                edge = inv & (d <= 1.6)
                col[edge] = fill[edge] * 0.55
            C[inv, :3] = np.clip(col[inv], 0, 255).astype(np.uint8)
            C[inv, 3] = 255
        C[rest, :3] = RGB[rest]
        C[rest, 3] = MA[rest]
    # rest-exactness: non-rest pixels only under a fully opaque owner drawn above
    nonrest = (C[..., 3] > 0) & ~rest
    ok = nonrest & (owner < k) & (MA == 255)
    C[nonrest & ~ok] = 0
    layers[name] = C
    parts.append(dict(name=name, z=k, visible=True, rest=int(rest.sum()), backfill=int(ok.sum())))

# verify: compose visible layers bottom -> top
cr = np.zeros((H, W, 3))
ca = np.zeros((H, W))
for p in reversed(parts):
    if not p['visible']:
        continue
    C = layers[p['name']]
    a = C[..., 3] / 255.0
    na = a + ca * (1 - a)
    cr = np.where(na[..., None] > 0, (C[..., :3] * a[..., None] + cr * (ca * (1 - a))[..., None]) /
                  np.maximum(na, 1e-12)[..., None], 0)
    ca = na
ea = np.abs(np.rint(ca * 255) - MA).max()
ec = np.abs(np.rint(cr) - RGB)[MA > 0].max()
print('rest composite vs mother-v2: alpha', ea, 'rgb', ec)
assert ea == 0 and ec == 0

for p in parts:
    C = layers[p['name']]
    ys, xs = np.nonzero(C[..., 3] > 0)
    if not len(xs):
        p['box'] = None
        continue
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    cv2.imwrite(os.path.join(outdir, 'layers', p['name'] + '.png'), C[y0:y1, x0:x1], [cv2.IMWRITE_PNG_COMPRESSION, 9])
    p['box'] = [x0, y0, x1 - x0, y1 - y0]
json.dump(dict(mother='mother-v2.png', size=[W, H], top_first=parts), open(os.path.join(outdir, 'parts.json'), 'w'),
          indent=1)
print(len(parts), 'layers;', sum(p.get('backfill', 0) for p in parts), 'backfill px')
