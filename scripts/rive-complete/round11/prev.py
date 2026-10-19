"""numpy preview helpers for hand pieces (same skinning maths as the Rive Skin; see round10_hand.py)."""
import sys, os, numpy as np, cv2
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import round10_hand as H
CLAP = {'thumb': (-0.35, -0.098, -0.078), 'index': (0, -0.14, -0.112), 'middle': (0, -0.154, -0.1232), 'ring': (0, -0.14, -0.112), 'little': (0, -0.126, -0.1008)}
def mirror(p): return {k: tuple(-a for a in v) for k, v in p.items()}
CLAP_L = {'thumb': (0.35, 0.098, 0.078), 'index': (0, 0.14, 0.112), 'middle': (0, 0.154, 0.1232), 'ring': (0, 0.14, 0.112), 'little': (0, 0.126, 0.1008)}
CLAP_R = CLAP
def coverage(side, pose, pieces=None, scale=6, box=None, thr=128):
    """-> bool union of piece alpha >= thr/255 at `scale` px/mother px, plus per-piece overlap-count image"""
    hb, png, cols, rows = H.grid(side)
    th, tw = np.array(png).shape[:2]
    pieces = pieces or H.build_pieces(side)
    if box is None: box = (hb[0] - 25, hb[1] - 5, hb[2] + 25, hb[3] + 30)
    W, Hh = (box[2] - box[0]) * scale, (box[3] - box[1]) * scale
    cnt = np.zeros((Hh, W), np.float32); acc = np.zeros((Hh, W), np.float32)
    for nm in ['palm'] + list(H.ORDER):
        pc = pieces[nm]
        verts, tris, pos = H.deform(side, pc, pose)
        tex = pc.tex[..., 3].astype(np.float32)
        layer = np.zeros((Hh, W), np.float32)
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
        cnt += (layer >= thr / 255.0); acc = 1 - (1 - acc) * (1 - layer)
    return acc, cnt, box

def holes(cov, scale, k=7):
    """thin-gap px (artboard mother px units): closing(k mother px)-cov restricted to being enclosed-ish"""
    m = (cov >= 0.5).astype(np.uint8)
    K = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE, K) - m

def gapviz(side, pose, pieces, scale=6, path=None, k=4):
    import cv2
    from PIL import Image
    c0, n0, box = coverage(side, {}, pieces, scale); c1, n1, _ = coverage(side, pose, pieces, scale)
    kk = int(k * scale) | 1
    h0 = holes(c0, scale, kk); h1 = holes(c1, scale, kk)
    new = h1 & ~cv2.dilate(h0, np.ones((9, 9), np.uint8))
    img = np.zeros(c1.shape + (3,), np.uint8) + 30
    img[c1 >= .5] = (190, 170, 150)
    img[n1 >= 2] = (120, 160, 220)
    img[new > 0] = (255, 0, 255)
    if path: Image.fromarray(img).save(path)
    return new.sum() / scale ** 2, h1.sum() / scale ** 2, (n0.sum() / max((n0 > 0).sum(), 1))

COLS = dict(palm=(150, 150, 150), little=(230, 60, 60), ring=(240, 150, 40), middle=(240, 230, 60), index=(60, 200, 80), thumb=(70, 110, 240))
def colorviz(side, pose, pieces, scale=8, path=None, box=None):
    import cv2
    from PIL import Image
    hb, png, cols, rows = H.grid(side)
    th, tw = np.array(png).shape[:2]
    if box is None: box = (hb[0] - 25, hb[1] - 5, hb[2] + 25, hb[3] + 30)
    W, Hh = (box[2] - box[0]) * scale, (box[3] - box[1]) * scale
    img = np.zeros((Hh, W, 3), np.float32) + 30
    for nm in ['palm'] + list(H.ORDER):
        pc = pieces[nm]
        verts, tris, pos = H.deform(side, pc, pose)
        tex = pc.tex[..., 3].astype(np.float32)
        col = np.array(COLS[nm], np.float32)
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
            a = ((patch / 255.0) * (m / 255.0))[..., None]
            reg = img[y0c:y1c, x0c:x1c]; img[y0c:y1c, x0c:x1c] = reg * (1 - a) + col * a
    img = img.astype(np.uint8)
    if path: Image.fromarray(img).save(path)
    return img
