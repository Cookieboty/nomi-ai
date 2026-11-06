"""Re-cut both hands by hand-annotated anatomy and fit the finger joints to the drawing.

The mother shows the backs of both hands hanging down: the index finger reaches down past the
knuckles, the thumb presses down the middle, and middle / ring / little are curled behind the thumb
with only their tips showing. Regions and joints below were traced on the mother at 9x zoom.

Pieces (rigid, one bone each): palm (hand bone), thumb p0..p2, index p0..p2, middle / ring / little.
Each finger piece also takes the fully opaque mother pixels 2 px into its neighbours below it (hides the
seam when it turns); the palm is completed under every finger with the neighbouring skin, so a turning
finger never opens a hole. Rest pose stays pixel-exact.
usage: hand_rig.py <rig dir> <mother-v2.png> [--preview out.png]"""
import sys, os, json
import numpy as np
import cv2

rig_dir, mother = sys.argv[1:3]
PREV = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
M = cv2.imread(mother, cv2.IMREAD_UNCHANGED)
RGB, MA = M[..., :3], M[..., 3]
H, W = MA.shape

# joints: finger -> [j0, j1, j2, tip] (index / thumb) or [j0, tip] (curled fingers)
JOINTS = {
    'l': {'index': [(303, 794), (312, 807), (317, 817), (320, 826)],
          'thumb': [(327, 756), (328, 776), (327, 790), (326, 803)],
          'middle': [(325, 783), (345, 781)], 'ring': [(325, 795), (347, 797)], 'little': [(325, 805), (342, 809)]},
    'r': {'index': [(712, 795), (705, 808), (700, 817), (697, 823)],
          'thumb': [(686, 755), (687, 773), (689, 786), (690, 796)],
          'middle': [(693, 781), (675, 777)], 'ring': [(693, 793), (673, 791)], 'little': [(694, 803), (676, 805)]},
}
POLY = {
    'l': {'thumb': [(316, 749), (338, 746), (339, 768), (334, 786), (331, 798), (328, 806), (321, 805),
                    (319, 792), (320, 779), (317, 767), (313, 757)],
          'curled': [(330, 776), (352, 774), (352, 815), (325, 815), (323, 807), (329, 800), (333, 788)],
          'index': [(289, 787), (306, 790), (318, 797), (325, 806), (327, 822), (321, 830), (312, 823),
                    (300, 806), (288, 796)]},
    'r': {'thumb': [(677, 745), (696, 745), (697, 760), (695, 774), (693, 789), (691, 798), (685, 797),
                    (683, 783), (681, 769), (677, 756)],
          'curled': [(664, 768), (683, 768), (684, 790), (690, 799), (689, 810), (664, 812)],
          'index': [(724, 779), (726, 791), (716, 806), (705, 822), (698, 828), (693, 820), (698, 806),
                    (710, 794)]},
}
KNUCKLE = {'l': dict(y=792, cap=9), 'r': dict(y=792, cap=9)}
CURL_SPLIT = {'l': (789, 801), 'r': (784, 797)}     # y between middle / ring / little


def poly(pts):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.array(pts, np.int32)], 1)
    return m.astype(bool)


def seg_side(p, a, b):
    """Signed side of p relative to the line a->b, >0 beyond the joint (towards b)."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    yy, xx = np.mgrid[0:H, 0:W]
    return (xx - a[0]) * d[0] + (yy - a[1]) * d[1]


meta_p = os.path.join(rig_dir, 'parts.json')
meta = json.load(open(meta_p))
parts = meta['top_first']
yy, xx = np.mgrid[0:H, 0:W]
new_bind = {}
prev_tiles = []
for s in 'lr':
    names = [p['name'] for p in parts if p['name'].startswith(f'hand-{s}-')]
    hand = np.zeros((H, W, 4), np.uint8)
    for n in names:
        p = next(q for q in parts if q['name'] == n)
        if not p.get('visible') or not p.get('box'):
            continue
        x, y, w, h = p['box']
        L = cv2.imread(os.path.join(rig_dir, 'layers', n + '.png'), cv2.IMREAD_UNCHANGED)
        C = np.zeros((H, W, 4), np.uint8)
        C[y:y + h, x:x + w] = L
        a = C[..., 3:] / 255.0
        hand[..., :3] = (C[..., :3] * a + hand[..., :3] * (1 - a)).astype(np.uint8)
        hand[..., 3] = np.maximum(hand[..., 3], C[..., 3])
    rest = hand[..., 3] > 0
    # the rest pixels must be the mother's: take them from the mother (pieces were cut from it)
    reg = {}
    reg['thumb'] = rest & poly(POLY[s]['thumb'])
    cur = rest & poly(POLY[s]['curled']) & ~reg['thumb']
    y1, y2 = CURL_SPLIT[s]
    reg['middle'] = cur & (yy < y1)
    reg['ring'] = cur & (yy >= y1) & (yy < y2)
    reg['little'] = cur & (yy >= y2)
    idx = rest & poly(POLY[s]['index']) & ~reg['thumb'] & ~cur
    j = JOINTS[s]['index']
    reg['index-p0'] = idx & (seg_side(None, j[1], j[0]) >= 0)            # before j1
    reg['index-p1'] = idx & (seg_side(None, j[1], j[0]) < 0) & (seg_side(None, j[2], j[1]) >= 0)
    reg['index-p2'] = idx & (seg_side(None, j[2], j[1]) < 0)
    t = JOINTS[s]['thumb']
    th = reg.pop('thumb')
    reg['thumb-p0'] = th & (seg_side(None, t[1], t[0]) >= 0)
    reg['thumb-p1'] = th & (seg_side(None, t[1], t[0]) < 0) & (seg_side(None, t[2], t[1]) >= 0)
    reg['thumb-p2'] = th & (seg_side(None, t[2], t[1]) < 0)
    taken = np.zeros((H, W), bool)
    for m in reg.values():
        taken |= m
    reg['palm'] = rest & ~taken
    # draw order, top first: index tip .. base, thumb tip .. base, curled fingers, palm
    order = ['index-p2', 'index-p1', 'index-p0', 'thumb-p2', 'thumb-p1', 'thumb-p0', 'little', 'ring', 'middle', 'palm']
    zi = {n: i for i, n in enumerate(order)}
    owner = np.full((H, W), 99)
    for n, m in reg.items():
        owner[m] = zi[n]
    opaque = MA == 255
    layers = {}
    for n in order:
        m = reg[n]
        C = np.zeros((H, W, 4), np.uint8)
        if n == 'palm':
            # complete the back of the hand under the fingers with its own skin
            known = m & opaque
            fillm = rest & ~m
            tel = cv2.inpaint(RGB, (~known).astype(np.uint8), 5, cv2.INPAINT_TELEA)
            tel = cv2.GaussianBlur(tel, (0, 0), 1.0)
            keep = fillm & opaque          # only where the finger above is opaque at rest
            C[keep, :3] = tel[keep]
            C[keep, 3] = 255
        else:
            grow = cv2.dilate(m.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
            ext = grow & ~m & rest & opaque & (owner > zi[n])
            C[ext, :3] = RGB[ext]
            C[ext, 3] = 255
        C[m, :3] = RGB[m]
        C[m, 3] = MA[m]
        layers[n] = C
    # replace the old hand pieces in the part list
    at = min(i for i, p in enumerate(parts) if p['name'].startswith(f'hand-{s}-'))
    for n in names:
        fp = os.path.join(rig_dir, 'layers', n + '.png')
        if os.path.exists(fp):
            os.remove(fp)
    parts = [p for p in parts if not p['name'].startswith(f'hand-{s}-')]
    newp = []
    for n in order:
        C = layers[n]
        ys, xs = np.nonzero(C[..., 3] > 0)
        x0, y0, x1, y1_ = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        nm = f'hand-{s}-{n}'
        cv2.imwrite(os.path.join(rig_dir, 'layers', nm + '.png'), C[y0:y1_, x0:x1])
        newp.append(dict(name=nm, z=None, visible=True, box=[int(x0), int(y0), int(x1 - x0), int(y1_ - y0)]))
    # clean copies for when the hand leaves its rest place: the drawing's edge ring is opaque and mixed with
    # the ribbon / shorts behind it, so it would travel as an orange / dark fringe. Unmix it: colour = nearest
    # interior skin, alpha from where the pixel lies between that skin and the background it was drawn over.
    sil = rest.astype(np.uint8)
    din = cv2.distanceTransform(sil, cv2.DIST_L2, 5)
    inner = (din > 3.0).astype(np.uint8)
    _, lin = cv2.distanceTransformWithLabels(1 - inner, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    iy, ix = np.nonzero(inner)
    lut = np.zeros(lin.max() + 1, np.int64)
    lut[lin[inner > 0]] = np.arange(len(iy))
    outside = (1 - sil).astype(np.uint8)
    _, lout = cv2.distanceTransformWithLabels(sil, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    oy, ox = np.nonzero(outside)
    lut2 = np.zeros(lout.max() + 1, np.int64)
    lut2[lout[outside > 0]] = np.arange(len(oy))
    ring = rest & (din <= 3.0)
    ry, rx = np.nonzero(ring)
    Fi = lut[lin[ry, rx]]
    Fc = RGB[iy[Fi], ix[Fi]].astype(np.float32)
    Bi = lut2[lout[ry, rx]]
    Bc = RGB[oy[Bi], ox[Bi]].astype(np.float32)
    Cc = RGB[ry, rx].astype(np.float32)
    # classify each ring pixel: skin or line art (keep, opaque) vs. drawn-over background (drop), by which of
    # the three reference colours it is closest to; then antialias the kept silhouette by 1 px
    inner_px = RGB[inner > 0].astype(np.float32)
    lumi = inner_px.mean(1)
    LINEC = np.median(inner_px[lumi < np.percentile(lumi, 6)], 0)
    dF = np.linalg.norm(Cc - Fc, axis=1)
    dB = np.linalg.norm(Cc - Bc, axis=1)
    dL = np.linalg.norm(Cc - LINEC, axis=1)
    keep = (np.minimum(dF, dL) <= dB) | (np.linalg.norm(Fc - Bc, axis=1) < 25)
    km = rest.copy()
    km[ry[~keep], rx[~keep]] = False
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(km.astype(np.uint8), 8)
    if n2 > 2:
        big = 1 + int(np.argmax(st2[1:, 4]))
        for c2 in range(1, n2):
            if c2 != big and st2[c2, 4] < 30:
                km[lab2 == c2] = False
    soft = cv2.GaussianBlur(km.astype(np.float32), (0, 0), 0.6)
    clean_rgb = RGB.copy()
    clean_a = MA.astype(np.float32).copy()
    clean_a[rest] = np.where(km[rest], np.maximum(soft[rest], 0.0) * 255, 0)
    clean_a[rest & km & (din > 1.5)] = 255
    for q in list(newp):
        C = layers[q['name'].split(f'hand-{s}-', 1)[1]].copy()
        m = C[..., 3] > 0
        own = m & rest
        C[own, :3] = clean_rgb[own]
        C[own, 3] = np.minimum(C[own, 3], clean_a[own]).astype(np.uint8)
        C[C[..., 3] == 0] = 0
        x0, y0, w0, h0 = q['box']
        nm = q['name'] + '-clean'
        cv2.imwrite(os.path.join(rig_dir, 'layers', nm + '.png'), C[y0:y0 + h0, x0:x0 + w0])
        newp.insert(newp.index(q) + 1, dict(name=nm, z=None, visible=False, alternate=True, box=list(q['box'])))
    # fist sprite: the back of the drawn hand down to the knuckles, the gap between index and thumb filled with
    # the hand's own skin, the knuckle edge rounded and outlined with the drawing's line colour
    kn = KNUCKLE[s]
    top = rest & (yy <= kn['y'])
    xs_ = np.nonzero(top.any(0))[0]
    x0f, x1f = xs_.min(), xs_.max()
    cap = (((xx - (x0f + x1f) / 2) / max((x1f - x0f) / 2, 1)) ** 2 + ((yy - kn['y']) / kn['cap']) ** 2) <= 1
    fm = top | (cap & (yy > kn['y']) & (xx >= x0f) & (xx <= x1f))
    ff = fm.astype(np.uint8).copy()
    pad = np.zeros((H + 2, W + 2), np.uint8)
    cv2.floodFill(ff, pad, (0, 0), 1)
    fm = fm | (ff == 0)
    pts_ = np.column_stack(np.nonzero(fm)[::-1]).astype(np.int32)
    hull = cv2.convexHull(pts_)
    hm = np.zeros((H, W), np.uint8)
    cv2.fillConvexPoly(hm, hull, 1)
    fm = cv2.erode(hm, np.ones((3, 3), np.uint8)).astype(bool)
    skinsrc = (reg['palm'] | reg['thumb-p0'] | reg['thumb-p1']) & opaque & (din > 2.5) & km
    telf = cv2.inpaint(RGB, (~skinsrc).astype(np.uint8), 6, cv2.INPAINT_TELEA)
    telf = cv2.GaussianBlur(telf, (0, 0), 1.2)
    C = np.zeros((H, W, 4), np.uint8)
    keep_orig = fm & (reg['palm'] | reg['thumb-p0'] | reg['thumb-p1']) & km & (din > 3.5) & \
        (cv2.distanceTransform(fm.astype(np.uint8), cv2.DIST_L2, 5) > 3)
    C[fm, :3] = telf[fm]
    C[keep_orig, :3] = RGB[keep_orig]
    C[fm, 3] = 255
    inner_l = cv2.erode(fm.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    edge = fm & ~inner_l
    C[edge, :3] = (C[edge, :3] * 0.35 + LINEC * 0.65).astype(np.uint8)
    for i in range(1, 4):                         # knuckle creases
        cx_ = int(x0f + (x1f - x0f) * i / 4)
        cv2.line(C, (cx_, kn['y'] - 2), (cx_ + (1 if s == 'r' else -1), kn['y'] + kn['cap'] - 3),
                 tuple(int(v) for v in LINEC) + (255,), 1, cv2.LINE_AA)
    C[~fm] = 0
    sa = cv2.GaussianBlur(fm.astype(np.float32), (0, 0), 0.7)
    C[..., 3] = np.where(fm, np.clip(sa * 2 - 0.2, 0, 1) * 255, 0).astype(np.uint8)
    ys2, xs2 = np.nonzero(C[..., 3] > 0)
    bx = [int(xs2.min()), int(ys2.min()), int(xs2.max() - xs2.min() + 1), int(ys2.max() - ys2.min() + 1)]
    cv2.imwrite(os.path.join(rig_dir, 'layers', f'hand-{s}-fist.png'), C[bx[1]:bx[1] + bx[3], bx[0]:bx[0] + bx[2]])
    newp.insert(0, dict(name=f'hand-{s}-fist', z=None, visible=False, alternate=True, box=bx))
    parts[at:at] = newp
    if PREV:
        rng = np.random.default_rng(1)
        v = RGB[720:840, 260:370].astype(float) if s == 'l' else RGB[720:840, 650:760].astype(float)
        ox = 260 if s == 'l' else 650
        lab = np.zeros_like(v)
        for n in order:
            m = reg[n][720:840, ox:ox + 110]
            lab[m] = rng.integers(60, 255, 3)
        big = cv2.resize(np.hstack([v, v * 0.45 + lab * 0.55]).astype(np.uint8), None, fx=5, fy=5, interpolation=cv2.INTER_NEAREST)
        for f, pts in JOINTS[s].items():
            P = [(int((x - ox) * 5) + 550, int((y - 720) * 5)) for x, y in pts]
            for a_, b_ in zip(P[:-1], P[1:]):
                cv2.line(big, a_, b_, (255, 255, 255), 1)
            for q in P:
                cv2.circle(big, q, 4, (255, 255, 255), -1)
        prev_tiles.append(big)
meta['top_first'] = parts
json.dump(meta, open(meta_p, 'w'), indent=1)
json.dump(JOINTS, open(os.path.join(rig_dir, 'hand-joints.json'), 'w'), indent=1)
json.dump(JOINTS, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hand-joints.json'), 'w'), indent=1)
if PREV:
    cv2.imwrite(PREV, np.vstack(prev_tiles))
print('hands re-cut')
