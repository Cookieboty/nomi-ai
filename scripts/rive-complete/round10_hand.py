#!/usr/bin/env python3
"""ROUND10 hand pieces: palm + 5 finger pieces cut from the ONE hand crop (no bridging triangles).

Why: with one continuous skinned mesh (ROUND9) a closing fist stretches the soft weight band between the finger and the
palm into thin "strings" (every triangle that straddles differently-weighted vertices is sheared by the finger's
displacement).  Here the grid cells are split by ownership: the palm piece keeps the palm (+ the first few px of each
finger as a hinge), every finger piece keeps its own cells + a 1-cell ring and follows ONLY its 3 finger bones (rigid
chain, joint blend only along the finger axis).  No triangle connects two differently-weighted vertices, so nothing can
be sheared; the ring / hinge overlap (<= 1 cell) is the only overdraw and is pixel-identical at rest.
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
RING = 1.5                      # px: finger piece also carries this ring of neighbouring (palm) texels = hinge/edge overlap


@dataclass
class Piece:
    name: str                   # "palm" | finger name
    tex: np.ndarray             # (h, w, 4) uint8 piece texture (hand crop with the piece's alpha)
    bones: list                 # bone keys: "hand","fore", or (finger, 0/1/2)
    cells: np.ndarray = None    # (rows-1, cols-1) bool, cells that carry opaque texels


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


def build_pieces(side: str):
    hb, png, cols, rows = grid(side)
    tex = np.array(png)
    h, w = tex.shape[:2]
    a0 = tex[..., 3].astype(np.float32) / 255.0
    geo = {nm: pixel_geom(side, nm, w, h, hb) for nm in FINGERS}
    # a texel belongs to the finger whose capsule it is deepest inside (most negative d - r_eff)
    depth = np.stack([geo[nm][0] for nm in FINGERS])
    owner = np.argmin(depth, 0)
    pieces = {}
    palm_a = a0.copy()
    for k, nm in enumerate(FINGERS):
        d, al = geo[nm]
        mine = (owner == k) & (d <= 0.0)
        base = ramp(al, -1.5, 0.0)                      # feathered start at the MCP (hinge)
        take = ramp(-(d - RING), 0.0, 1.0)              # 1 up to RING px outside the owned capsule, AA over 1px
        take = np.where(mine, 1.0, take)
        fa = a0 * take * base
        fa = np.where(mine & (al >= 0), a0, fa)         # owned texels: exactly the source alpha
        # palm gives up the owned texels beyond the hinge zone (finger piece covers them + RING px more at rest)
        cut = np.where(mine, ramp(al, 1.5, 3.5), 0.0)
        palm_a = palm_a * (1.0 - cut)
        t = tex.copy(); t[..., 3] = np.round(fa * 255).astype(np.uint8)
        pieces[nm] = Piece(nm, t, [(nm, 0), (nm, 1), (nm, 2)])
    t = tex.copy(); t[..., 3] = np.round(palm_a * 255).astype(np.uint8)
    pieces["palm"] = Piece("palm", t, ["hand", "fore"])
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


def weights(side: str, piece: Piece, mx: float, my: float) -> list[float]:
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
    order = ["palm"] + list(ORDER)
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
