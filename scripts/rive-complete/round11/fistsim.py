"""fistsim.py: outside-hull metric of the fist pose family in the numpy preview.
outside(side, pose_fn, f) = px of the hand union (alpha>=.5) outside the rest-hand convex hull dilated by 3 art px (3.5 mother px)."""
import os, sys, math, numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prev
H = prev.H
CURL = {"thumb": (-27.0, -76.0, -40.0), "index": (40.0, 63.0, 46.0), "middle": (-100.0, -45.0, -55.0), "ring": (-100.0, -45.0, -55.0), "little": (-100.0, -45.0, -55.0)}
def pose_of(side, factors):
    """factors: {finger: (f_root, f_p1, f_p2)} -> pose dict in radians (right hand mirrored)"""
    sg = 1.0 if side == 'l' else -1.0
    return {nm: tuple(math.radians(sg * CURL[nm][j]) * factors[nm][j] for j in range(3)) for nm in CURL if nm in factors}
def hull_of(cov, scale):
    m = (cov >= .5).astype(np.uint8)
    cn, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hm = np.zeros_like(m); cv2.fillPoly(hm, [cv2.convexHull(np.concatenate(cn))], 1)
    k = int(round(3.5 * scale)) | 1
    return cv2.dilate(hm, np.ones((k, k), np.uint8))
class Sim:
    def __init__(self, P, scale=4):
        self.P, self.sc = P, scale
        self.hull = {}; self.boxes = {}
        for s in 'lr':
            c0, _, self.boxes[s] = prev.coverage(s, {}, P[s], scale)
            self.hull[s] = hull_of(c0, scale)
    def outside(self, side, factors):
        c, _, _ = prev.coverage(side, pose_of(side, factors), self.P[side], self.sc)
        m = (c >= .5)
        return int((m & (self.hull[side] == 0)).sum() / self.sc ** 2), c

def piece_cov(side, nm, pose, P, scale, box):
    """alpha coverage (float) of ONE piece"""
    hb, png, cols, rows = H.grid(side)
    th, tw = np.array(png).shape[:2]
    W, Hh = (box[2] - box[0]) * scale, (box[3] - box[1]) * scale
    layer = np.zeros((Hh, W), np.float32)
    pc = P[side][nm]
    verts, tris, pos = H.deform(side, pc, pose)
    tex = pc.tex[..., 3].astype(np.float32)
    for t in tris:
        src = np.float32([[verts[i][2] * tw, verts[i][3] * th] for i in t])
        dst = np.float32([[(pos[i][0] - box[0]) * scale, (pos[i][1] - box[1]) * scale] for i in t])
        x0, y0 = np.floor(dst.min(0)).astype(int) - 1; x1, y1 = np.ceil(dst.max(0)).astype(int) + 1
        x0c, y0c, x1c, y1c = max(x0, 0), max(y0, 0), min(x1, W), min(y1, Hh)
        if x1c <= x0c or y1c <= y0c: continue
        Mx = cv2.getAffineTransform(src, dst - np.float32([x0c, y0c]))
        patch = cv2.warpAffine(tex, Mx, (x1c - x0c, y1c - y0c), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        m = np.zeros((y1c - y0c, x1c - x0c), np.uint8)
        cv2.fillConvexPoly(m, np.int32(np.round((dst - np.float32([x0c, y0c])) * 16)), 255, lineType=cv2.LINE_AA, shift=4)
        a = (patch / 255.0) * (m / 255.0)
        reg = layer[y0c:y1c, x0c:x1c]; np.maximum(reg, a, out=reg)
    return layer

class Sim2(Sim):
    """outline for the thumb path: convex hull of (rest thumb ∪ closed-fist thumb ∪ rest palm ∪ closed-fist hand) dilated by 3 art px
    = the region the thumb may sweep without 'extending outward' between its two end poses"""
    def __init__(self, P, scale=3):
        super().__init__(P, scale)
        self.hull_rest = dict(self.hull)
        for s in 'lr':
            c1, _, _ = prev.coverage(s, pose_of(s, {n: (1, 1, 1) for n in CURL}), P[s], scale)
            pal = piece_cov(s, 'palm', {}, P, scale, self.boxes[s])
            tr = piece_cov(s, 'thumb', {}, P, scale, self.boxes[s])
            u = np.maximum(np.maximum(c1, pal), tr)
            self.hull[s] = hull_of(u, scale)

class Sim3(Sim):
    """sideways excursion: thumb px outside the palm's rest horizontal band (palm piece x-extent at rest, +3 art px each side).
    (the thumb must not poke out sideways beyond the palm width while it folds across.)"""
    def __init__(self, P, scale=3):
        super().__init__(P, scale)
        self.band = {}
        for s in 'lr':
            pal = piece_cov(s, 'palm', {}, P, scale, self.boxes[s]) >= .5
            xs = np.where(pal.any(0))[0]
            pad = int(round(3.5 * scale))
            b = np.zeros(pal.shape, bool); b[:, max(xs.min() - pad, 0):xs.max() + pad + 1] = True
            self.band[s] = b
    def out_thumb(self, side, pose):
        c = piece_cov(side, 'thumb', pose, self.P, self.sc, self.boxes[side]) >= .5
        return int((c & ~self.band[side]).sum() / self.sc ** 2)
