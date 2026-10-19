#!/usr/bin/env python3
"""ROUND10 hand pieces: palm + 5 finger pieces cut from the ONE hand crop (no bridging triangles).

Why: with one continuous skinned mesh (ROUND9) a closing fist stretches the soft weight band between the finger and the
palm into thin "strings" (every triangle that straddles differently-weighted vertices is sheared by the finger's
displacement).  Here the grid cells are split by ownership: the palm piece keeps the palm (+ the first few px of each
finger as a hinge), every finger piece keeps its own cells + a 1-cell ring and follows ONLY its 3 finger bones (rigid
chain, joint blend only along the finger axis).  No triangle connects two differently-weighted vertices, so nothing can
be sheared; the ring / hinge overlap (<= 1 cell) is the only overdraw and is pixel-identical at rest.
ROUND11: ownership is unchanged but the alphas now carry under-skirts (see build_pieces) so a rotating finger/thumb never opens a gap.
Also contains the numpy/OpenCV skinning preview used to design the fist (same maths as the Rive Skin).
"""
from __future__ import annotations

import io
import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

import round9_rig as RIG

ROOT = Path(__file__).resolve().parents[2]
SVG = ROOT / "rive" / "nomi-complete" / "reference" / "svg-rig"
S = 0.8463541666666666
CELL = 2.2                      # artboard px (same as ROUND9)
FINGERS = RIG.FINGERS
ORDER = ("little", "ring", "middle", "index", "thumb")   # draw order on top of the palm (thumb folds over the fingers)
HINGE_IN, HINGE_OUT = 2.0, 6.0  # along-axis px (mother): finger cells start owning at HINGE_IN, palm drops them at HINGE_OUT
OWN_MARGIN = {"thumb": 2.0, "index": 2.0, "middle": 4.0, "ring": 4.0, "little": 4.0}   # px (mother) added to the capsule radius
TIP_EXT = 8.0                   # px: axis extended past the fingertip so the whole tip is owned
WEB_GROW = 1                    # px: the web patch extends this far under the neighbouring pieces
WEB_RIM = 3                     # px: partial-alpha texels this close to the opening are backed by the patch too
WEB_SHADE = 0.18                # 0..1: how far the web fill is mixed toward the outline colour at its deepest point
RING = 1.0                      # px: finger piece also carries this ring of neighbouring (palm) texels = hinge/edge overlap (R10: 1.5)
SKIRT_FINGER = 2.0              # px: under-skirt a finger piece carries of its neighbour fingers' texels
SKIRT_THUMB = 8.0               # px: ... when the neighbour is the thumb (thumb root swings 20-27 deg in clap/fist)
SKIRT_PALM_FINGER = 2.5         # px: under-skirt of finger texels carried by the palm
PALM_SKIRT_ALONG = 6.0          # px along the finger axis (from the MCP) up to which the palm carries a non-thumb finger's texels
SKIRT_PALM_THUMB = 8.0          # px: ... of thumb texels carried by the palm


@dataclass
class Piece:
    name: str                   # "palm" | finger name
    tex: np.ndarray             # (h, w, 4) uint8 piece texture (hand crop with the piece's alpha)
    bones: list                 # bone keys: "hand","fore", or (finger, 0/1/2)
    cells: np.ndarray = None    # (rows-1, cols-1) bool, cells that carry opaque texels
    aux: dict = None            # extra data for the weight function (web patch: distance maps)


PIN_R9 = "754f4a0"   # hand-<side>.png (the single ROUND9 hand crop) is read from here: the generator stays idempotent


def _git(path: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), "show", f"{PIN_R9}:{path}"])


def grid(side: str):
    hb = json.loads(_git("rive/nomi-complete/reference/svg-rig/rig-meta.json"))["boxes"][f"hand-{side}"]
    png = Image.open(io.BytesIO(_git(f"rive/nomi-complete/reference/svg-rig/hand-{side}.png"))).convert("RGBA")
    w, h = png.size
    cols = max(2, int(round(w * S / CELL)) + 1)
    rows = max(2, int(round(h * S / CELL)) + 1)
    return hb, png, cols, rows


def geom(side: str, mx: float, my: float, name: str):
    """(dn, along, s) of a mother-px point against a finger capsule axis"""
    f = RIG.JOINTS[side][name]
    pts, r = f["pts"], f["r"]
    best = None
    s0 = 0.0
    L = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(3)]
    for i in range(3):
        t, d = RIG._seg_proj((mx, my), pts[i], pts[i + 1])
        if best is None or d < best[0]:
            best = (d, s0 + t * L[i])
        s0 += L[i]
    d, s = best
    a0, a1 = pts[0], pts[1]
    ux, uy = a1[0] - a0[0], a1[1] - a0[1]
    ln = math.hypot(ux, uy) or 1.0
    along = ((mx - a0[0]) * ux + (my - a0[1]) * uy) / ln
    return d / (r + OWN_MARGIN[name]), along, s


def cell_centers(side):
    hb, png, cols, rows = grid(side)
    w, h = png.size
    cx = hb[0] + w * (np.arange(cols - 1) + 0.5) / (cols - 1)
    cy = hb[1] + h * (np.arange(rows - 1) + 0.5) / (rows - 1)
    return hb, png, cols, rows, cx, cy


def pixel_geom(side: str, name: str, w: int, h: int, hb):
    """per-texel (dn_px = d - r_eff in mother px, along) arrays for one finger capsule (texel centres)"""
    xs = hb[0] + np.arange(w) + 0.5
    ys = hb[1] + np.arange(h) + 0.5
    dd = np.zeros((h, w)); aa = np.zeros((h, w))
    f = RIG.JOINTS[side][name]
    pts = f["pts"]
    A = [np.array(p, float) for p in pts]
    tipdir = A[3] - A[2]; A.append(A[3] + tipdir / np.linalg.norm(tipdir) * TIP_EXT)
    P = np.stack(np.meshgrid(xs, ys), -1)             # h,w,2
    best = np.full((h, w), 1e9)
    for i in range(4):
        ab = A[i + 1] - A[i]
        t = np.clip(((P - A[i]) @ ab) / (ab @ ab), 0, 1)
        q = A[i] + t[..., None] * ab
        d = np.linalg.norm(P - q, axis=-1)
        best = np.minimum(best, d)
    u = A[1] - A[0]; ln = np.linalg.norm(u)
    along = ((P - A[0]) @ u) / ln
    return best - (f["r"] + OWN_MARGIN[name]), along


def ramp(x, lo, hi):
    """0 at x<=lo, 1 at x>=hi"""
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def dist_to(mask: np.ndarray) -> np.ndarray:
    """distance (texel = mother px) of every texel to the nearest True texel of ``mask``"""
    return cv2.distanceTransform((~mask).astype(np.uint8), cv2.DIST_L2, 5)


def web_patch(tex: np.ndarray, a0: np.ndarray):
    """ROUND12 web (虎口) patch: the mother art has a built-in opening between thumb and index (enclosed, alpha 0, ~70-80 px).
    Returns (rgba patch drawn UNDER the hand pieces or None, hole mask).  Colour is derived from the neighbouring mother pixels:
    skin = median of opaque, non-outline pixels 2.5-7 px from the hole, outline = median of the opaque pixels touching it; the fill is the
    skin colour mixed toward the outline colour by WEB_SHADE (deepest in the middle, 30 % of that at the border) so it reads as the
    shaded crease of the web, not as a flat patch.  The ring of partial-alpha / outline pixels around the hole stays in the finger pieces
    and is drawn over the patch, so the outline is the original one."""
    m = (a0 > 0).astype(np.uint8)
    pad = np.pad(1 - m, 1, constant_values=1).astype(np.uint8)
    ff = pad.copy()
    cv2.floodFill(ff, None, (0, 0), 2)
    hole = ff[1:-1, 1:-1] == 1
    n, lab, st, _ = cv2.connectedComponentsWithStats(hole.astype(np.uint8))
    big = np.zeros(hole.shape, bool)
    for i in range(1, n):
        if st[i, 4] >= 20:                 # the 1 px specks are not the web
            big |= lab == i
    if not big.any():
        return None, big
    rgb = tex[..., :3]
    a = tex[..., 3]
    d = cv2.distanceTransform((~big).astype(np.uint8), cv2.DIST_L2, 5)
    skin = (a >= 250) & (d >= 2.5) & (d <= 7) & (rgb[..., 0] > 190)
    near = (a >= 200) & (d <= 2.0)
    sc, oc = np.median(rgb[skin], 0), np.median(rgb[near], 0)
    k = WEB_GROW
    reg = cv2.dilate(big.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))) > 0
    # also back the anti-aliased (partial-alpha) rim of the opening, otherwise the dark background shows through it as grey dots
    rim = cv2.dilate(big.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * WEB_RIM + 1, 2 * WEB_RIM + 1))) > 0
    reg |= rim & (a0 < 0.99)
    dd = cv2.distanceTransform(reg.astype(np.uint8), cv2.DIST_L2, 5)
    dd = dd / max(dd.max(), 1)
    kk = (WEB_SHADE * (0.3 + 0.7 * dd))[..., None]
    fill = sc * (1 - kk) + oc * kk
    alpha = np.where(reg, 1.0, cv2.GaussianBlur(reg.astype(np.float32), (0, 0), 0.6))
    out = np.zeros(tex.shape, np.uint8)
    out[..., :3] = np.clip(fill, 0, 255).astype(np.uint8)
    out[..., 3] = np.round(alpha * 255).astype(np.uint8)
    return out, big


def build_pieces(side: str):
    """ROUND11 piece alphas.

    Ownership (unchanged from R10): a texel belongs to the finger whose capsule it is deepest inside (and beyond the MCP,
    along >= 0); everything else (palm, wrist, web) belongs to the palm.  Every piece carries
      * its owned texels (alpha 1),
      * an *under-skirt*: texels owned by neighbouring pieces that lie within ``U`` px of its own region.
        Skirts are hidden under the neighbour at rest (same texels, same place, pixel-identical), but when a neighbour
        rotates away (thumb root in clap/fist) the skirt keeps skin where the neighbour used to be, so no gap opens
        between thumb / index / palm.  R10 only had a 1.5 px ring + a 2 px hinge, so a 20 deg thumb swing opened a 2-5 px
        slit (R10 report: "dark seam in the clap left hand").
      * fingers additionally a ``RING`` px ring of palm texels (hinge/edge overlap; faded in over the MCP).
    The R10 rings were measured against the finger *capsules* (radius + margin), which let neighbouring finger pieces
    carry each other's whole capsule overlap (~1000 px/hand of redundant overdraw); here the ring/skirt are measured
    against the owned regions, so the total overdraw drops although the thumb skirt is much wider.
    """
    hb, png, cols, rows = grid(side)
    tex = np.array(png)
    h, w = tex.shape[:2]
    a0 = tex[..., 3].astype(np.float32) / 255.0
    geo = {nm: pixel_geom(side, nm, w, h, hb) for nm in FINGERS}
    depth = np.stack([geo[nm][0] for nm in FINGERS])
    owner = np.argmin(depth, 0)
    own = {}
    for k, nm in enumerate(FINGERS):
        d, al = geo[nm]
        own[nm] = (owner == k) & (d <= 0.0) & (al >= 0) & (a0 > 0)
    anyf = np.zeros((h, w), bool)
    for nm in FINGERS:
        anyf |= own[nm]
    own["palm"] = (a0 > 0) & ~anyf
    D = {nm: dist_to(own[nm]) for nm in own}
    pieces = {}
    for nm in ("palm",) + ORDER:
        cov = np.where(own[nm], 1.0, 0.0)
        for oj in own:
            if oj == nm:
                continue
            if nm == "palm":
                U = SKIRT_PALM_THUMB if oj == "thumb" else SKIRT_PALM_FINGER
            elif oj == "palm":
                U = RING
            else:
                U = SKIRT_THUMB if "thumb" in (nm, oj) else SKIRT_FINGER
            band = np.clip(U + 0.5 - D[nm], 0.0, 1.0)
            if nm != "palm" and oj == "palm":
                band = band * ramp(geo[nm][1], -1.5, 0.0)      # feathered start at the MCP (hinge)
            src = own[oj]
            if nm == "palm" and oj != "thumb":
                src = src & (geo[oj][1] <= PALM_SKIRT_ALONG)   # only the finger root: a folded finger must not leave a stub behind
            cov = np.maximum(cov, np.where(src, band, 0.0))
        t = tex.copy()
        t[..., 3] = np.round(a0 * cov * 255).astype(np.uint8)
        pieces[nm] = Piece(nm, t, ["hand", "fore"] if nm == "palm" else [(nm, 0), (nm, 1), (nm, 2)])
    web, _ = web_patch(tex, a0)
    if web is not None:
        pieces["web"] = Piece("web", web, ["hand", ("thumb", 0), ("index", 0)], aux={"D": D, "hb": hb})
    for p in pieces.values():
        p.cells = cells_of(p.tex[..., 3], cols, rows)
    return pieces


def cells_of(alpha: np.ndarray, cols: int, rows: int) -> np.ndarray:
    h, w = alpha.shape
    ch, cw = rows - 1, cols - 1
    cover = np.zeros((ch, cw), bool)
    for r in range(ch):
        y0, y1 = int(math.floor(h * r / ch)) - 1, int(math.ceil(h * (r + 1) / ch)) + 1
        for c in range(cw):
            x0, x1 = int(math.floor(w * c / cw)) - 1, int(math.ceil(w * (c + 1) / cw)) + 1
            cover[r, c] = alpha[max(y0, 0):y1, max(x0, 0):x1].max() > 0
    return cover


def palm_weights(side: str, mx: float, my: float) -> list[float]:
    wf = 1.0 - float(RIG.smooth01((my - (RIG.WRIST[side][1] - 1.0)) / RIG.WRIST_RAMP))
    return [1.0 - wf, wf]


def finger_weights(side: str, name: str, mx: float, my: float, joint_blend: float = 4.0) -> list[float]:
    f = RIG.JOINTS[side][name]
    pts = f["pts"]
    _, _, s = geom(side, mx, my, name)
    L = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(3)]
    S1, S2 = L[0], L[0] + L[1]
    u1 = float(RIG.smooth01((s - S1 + joint_blend) / (2 * joint_blend)))
    u2 = float(RIG.smooth01((s - S2 + joint_blend) / (2 * joint_blend)))
    return [1.0 - u1, u1 - u2, u2]


def web_weights(piece: Piece, mx: float, my: float) -> list[float]:
    """web patch: inverse-square distance to the palm / thumb / index owned regions -> [hand, thumb root, index root]
    (so it follows the palm at the top and stretches between the two finger roots)"""
    D, hb = piece.aux["D"], piece.aux["hb"]
    h, w = D["palm"].shape
    x = int(min(max(round(mx - hb[0] - 0.5), 0), w - 1))
    y = int(min(max(round(my - hb[1] - 0.5), 0), h - 1))
    v = [1.0 / (float(D[k][y, x]) + 1.0) ** 2 for k in ("palm", "thumb", "index")]
    t = sum(v)
    return [c / t for c in v]


def weights(side: str, piece: Piece, mx: float, my: float) -> list[float]:
    if piece.name == "web":
        return web_weights(piece, mx, my)
    return palm_weights(side, mx, my) if piece.name == "palm" else finger_weights(side, piece.name, mx, my)


def mesh_of(side: str, piece: Piece):
    """-> (verts [(mx,my,u,v)], tris [(i,j,k)], weights per vert)  (vertex numbering local to the piece)"""
    hb, png, cols, rows = grid(side)
    w, h = png.size
    used, tris = {}, []
    verts = []

    def vid(r, c):
        if (r, c) not in used:
            used[(r, c)] = len(verts)
            u, v = c / (cols - 1), r / (rows - 1)
            verts.append((hb[0] + w * u, hb[1] + h * v, u, v))
        return used[(r, c)]

    ch, cw = piece.cells.shape
    for r in range(ch):
        for c in range(cw):
            if piece.cells[r, c]:
                p0, p1, p2, p3 = vid(r, c), vid(r, c + 1), vid(r + 1, c + 1), vid(r + 1, c)
                tris += [(p0, p1, p2), (p0, p2, p3)]
    ws = [weights(side, piece, v[0], v[1]) for v in verts]
    return verts, tris, ws


# ------------------------------------------------------------------ preview skinning (mother px)
def rot(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])


def trans(x, y):
    return np.array([[1, 0, x], [0, 1, y], [0, 0, 1.0]])


def fk(side: str, pose: dict, wrist_rot: float = 0.0):
    """proper FK: returns {key: skin matrix}"""
    W = RIG.WRIST[side]
    hand_pose = trans(*W) @ rot(wrist_rot)            # world pose of the hand bone (rest = trans(W))
    hand_rest = trans(*W)
    out = {"hand": hand_pose @ np.linalg.inv(hand_rest), "fore": np.eye(3)}
    for nm in FINGERS:
        pts = RIG.JOINTS[side][nm]["pts"]
        a = pose.get(nm, (0.0, 0.0, 0.0))
        parent_pose, parent_rest, par_pt = hand_pose, hand_rest, W
        for i in range(3):
            off = trans(pts[i][0] - par_pt[0], pts[i][1] - par_pt[1])
            pose_w = parent_pose @ off @ rot(a[i])
            rest_w = parent_rest @ off
            out[(nm, i)] = pose_w @ np.linalg.inv(rest_w)
            parent_pose, parent_rest, par_pt = pose_w, rest_w, pts[i]
    return out


def deform(side: str, piece: Piece, pose: dict, wrist_rot: float = 0.0):
    verts, tris, ws = mesh_of(side, piece)
    M = fk(side, pose, wrist_rot)
    out = []
    for (mx, my, u, v), w in zip(verts, ws):
        p = np.array([mx, my, 1.0])
        q = sum(wi * (M[b] @ p) for wi, b in zip(w, piece.bones))
        out.append((q[0], q[1]))
    return verts, tris, out


def render(side: str, pose: dict, scale: int = 8, box=None, wrist_rot: float = 0.0, pieces=None, bg=(30, 30, 30)):
    hb, png, cols, rows = grid(side)
    th, tw = np.array(png).shape[:2]
    pieces = pieces or build_pieces(side)
    if box is None:
        box = (hb[0] - 25, hb[1] - 5, hb[2] + 25, hb[3] + 30)
    W, H = (box[2] - box[0]) * scale, (box[3] - box[1]) * scale
    canvas = np.zeros((H, W, 3), np.float32) + np.array(bg, np.float32)
    order = ["palm"] + (["web"] if "web" in pieces else []) + list(ORDER)
    for nm in order:
        pc = pieces[nm]
        verts, tris, pos = deform(side, pc, pose, wrist_rot)
        tex = pc.tex.astype(np.float32)
        for t in tris:
            src = np.float32([[verts[i][2] * tw, verts[i][3] * th] for i in t])
            dst = np.float32([[(pos[i][0] - box[0]) * scale, (pos[i][1] - box[1]) * scale] for i in t])
            x0, y0 = np.floor(dst.min(0)).astype(int) - 1; x1, y1 = np.ceil(dst.max(0)).astype(int) + 1
            if x1 < 0 or y1 < 0 or x0 >= W or y0 >= H or (x1 - x0) > W or (y1 - y0) > H:
                continue
            x0c, y0c, x1c, y1c = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
            if x1c <= x0c or y1c <= y0c:
                continue
            Mx = cv2.getAffineTransform(src, dst - np.float32([x0c, y0c]))
            patch = cv2.warpAffine(tex, Mx, (x1c - x0c, y1c - y0c), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
            m = np.zeros((y1c - y0c, x1c - x0c), np.uint8)
            cv2.fillConvexPoly(m, np.int32(np.round((dst - np.float32([x0c, y0c])) * 16)), 255, lineType=cv2.LINE_AA, shift=4)
            a = (patch[..., 3:4] / 255.0) * (m[..., None] / 255.0)
            reg = canvas[y0c:y1c, x0c:x1c]
            canvas[y0c:y1c, x0c:x1c] = reg * (1 - a) + patch[..., :3] * a
    return np.clip(canvas, 0, 255).astype(np.uint8)


if __name__ == "__main__":
    import sys
    for side in "lr":
        P = build_pieces(side)
        print(side, {k: int(v.cells.sum()) for k, v in P.items()})
