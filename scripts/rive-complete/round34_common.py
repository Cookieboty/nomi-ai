#!/usr/bin/env python3
"""ROUND34 helpers: mother-grid (1024x1536 source canvas, S=1300/1536) texture placement for waist accessories,
paste/extract between canvases, inpaint fill, license + build hook."""
from __future__ import annotations
import hashlib, json, re
from pathlib import Path
import numpy as np
import cv2
from PIL import Image
import round10_layers as L10

PROJECT = L10.PROJECT
ROOT = L10.ROOT
SCENE = PROJECT / "scene.rml"
SVG = PROJECT / "reference/svg-rig"
LICENSE = PROJECT / "parts/DETAIL_LICENSE.json"
BASE = "deterministic source-pixel rig layer derived from user supplied full-body mother"
S = 1300.0 / 1536.0
OX = (960.0 - 1024 * S) / 2.0  # 46.667: mother texel (0,0) -> artboard

# mother-grid origin (texel) of each waist texture
ORIGIN = {
    "belt-band.png": (418, 473),
    "waist-backfill.png": (418, 473),
    "belt-id.png": (435, 509),
    "belt-pouch.png": (553, 507),
    "shorts.png": (379, 507),
    "shorts-side-orange.png": (379, 507),
    "underlayer-bottom.png": (379, 507),
    "torso-tank.png": (410, 332),
    "coat-r-front.png": (594, 320),
    "coat-l-front.png": None,
    "fullbody-base-no-head-arms.png": (0, 0),
    "body-backfill.png": (0, 0),
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load(name: str) -> np.ndarray:
    return np.array(Image.open(SVG / name).convert("RGBA"))


def save(name: str, im: np.ndarray):
    Image.fromarray(im.astype(np.uint8)).save(SVG / name, optimize=True)


def art(mx: float, my: float):
    return OX + mx * S, my * S


def window(src_name: str, src: np.ndarray, dst_name: str, dst_shape) -> np.ndarray:
    """src texture resampled (exact, integer offset) into dst canvas grid; zeros outside."""
    sx, sy = ORIGIN[src_name]
    dx, dy = ORIGIN[dst_name]
    H, W = dst_shape[:2]
    out = np.zeros((H, W, 4), np.uint8)
    ox, oy = sx - dx, sy - dy
    h, w = src.shape[:2]
    x0, y0 = max(0, ox), max(0, oy)
    x1, y1 = min(W, ox + w), min(H, oy + h)
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = src[y0 - oy : y1 - oy, x0 - ox : x1 - ox]
    return out


def put(dst_name: str, dst: np.ndarray, src_name: str, patch: np.ndarray, mask: np.ndarray):
    """write patch (in src_name grid) into dst where mask (src grid) is True and inside dst. Returns count."""
    sx, sy = ORIGIN[src_name]
    dx, dy = ORIGIN[dst_name]
    ox, oy = sx - dx, sy - dy
    ys, xs = np.nonzero(mask)
    X, Y = xs + ox, ys + oy
    ok = (X >= 0) & (Y >= 0) & (X < dst.shape[1]) & (Y < dst.shape[0])
    dst[Y[ok], X[ok]] = patch[ys[ok], xs[ok]]
    return int(ok.sum())


def colour_masks(im: np.ndarray):
    r, g, b, a = (im[:, :, i].astype(np.float32) for i in range(4))
    lum = (r + g + b) / 3
    chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    orange = (a >= 8) & (r > 150) & ((r - b) > 60) & (g > 50) & (g < 215)
    white = (a >= 8) & (lum > 170) & (chroma < 45)
    silver = (a >= 8) & (lum > 110) & (chroma < 40)
    dark = (a >= 8) & (lum < 70)
    return dict(orange=orange, white=white, silver=silver, dark=dark, lum=lum, chroma=chroma, a=a)


def fabric_fill(ctx: np.ndarray, hole: np.ndarray, seed: int = 34, grain: float = 2.5, blur: float = 0.0) -> np.ndarray:
    """inpaint RGB of ctx inside hole (Telea from opaque context), add faint vertical-thread grain; alpha 255."""
    rgb = ctx[:, :, :3].copy()
    known = ctx[:, :, 3] >= 200
    m = (hole | ~known).astype(np.uint8)
    fill = cv2.inpaint(rgb, m, 5, cv2.INPAINT_TELEA)
    # second pass NS smooths Telea streaks
    fill2 = cv2.inpaint(rgb, m, 7, cv2.INPAINT_NS)
    fill = ((fill.astype(np.float32) + fill2.astype(np.float32)) / 2)
    if blur > 0:
        fill = cv2.GaussianBlur(fill, (0, 0), blur)
    rng = np.random.default_rng(seed)
    H, W = hole.shape
    col = rng.normal(0, grain, (1, W, 1)).repeat(H, 0)
    pix = rng.normal(0, grain * 0.5, (H, W, 1))
    fill = np.clip(fill + col + pix, 0, 255)
    out = ctx.copy()
    out[hole, :3] = fill[hole].astype(np.uint8)
    out[hole, 3] = 255
    return out


def update_license(entries: dict, note: str, tag: str):
    lic = json.load(open(LICENSE))
    for name, method in entries.items():
        path = SVG / name
        key = "reference/svg-rig/" + name
        if not path.exists():
            lic["assets"].pop(key, None)
            continue
        e = lic["assets"].setdefault(key, {})
        e.update(sha256=sha(path), bytes=path.stat().st_size, ai_generated=False, in_scene=True, method=BASE + "; " + method)
    if tag not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " " + note).strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")


def hook_build(script: str, after: str):
    p = ROOT / "scripts/rive-complete/round13_build.sh"
    bt = p.read_text()
    if script in bt:
        return
    needle = f"python3 {after}\n"
    bt = bt.replace(needle, needle + f"python3 {script}\n") if needle in bt else bt.rstrip() + f"\npython3 {script}\n"
    p.write_text(bt)


def asset_after(scene: str, after_file: str, aname: str, frel: str, aid: str) -> str:
    if f'name="{aname}"' in scene:
        return scene
    m = re.search(rf'<ImageAsset [^>]*file="reference/svg-rig/{re.escape(after_file)}"[^/]*/>', scene)
    return scene[: m.end()] + f'\n    <ImageAsset name="{aname}" file="{frel}" id="{aid}"/>' + scene[m.end() :]


# ------------------------------------------------------------------ secondary motion (damped pendulum + bounce)
def simulate(scene: str, anim: str, bone_name: str, L: float = 50.0, hz: float = 2.4, zeta: float = 0.32,
             rmax: float = 0.12, ymax: float = 2.0, gain: float = 1.0):
    """bone (child of full.pelvis) lag driven by its pivot's world acceleration + pelvis world rotation.
    returns frames, rot (rad, local), dy (px, local) — both 0 at first/last frame."""
    import round27_common as K
    fk = K.FK(scene)
    dur = int(re.search(rf'<LinearAnimation name="{re.escape(anim)}"[^>]*duration="(\d+)"', scene).group(1))
    fps = 60.0
    h = fk.h[bone_name]
    piv = np.array([h["x"], h["y"], 1.0])
    P, TH = [], []
    for f in range(dur + 1):
        M = fk.world("full.pelvis", anim, f)
        P.append((M @ piv)[:2]); TH.append(K.angle(M))
    P, TH = np.array(P), np.array(TH)
    dt = 1.0 / fps
    acc = np.zeros_like(P)
    acc[1:-1] = (P[2:] - 2 * P[1:-1] + P[:-2]) / dt ** 2
    w = 2 * np.pi * hz
    phi, dphi, y, dy = TH[0], 0.0, 0.0, 0.0
    rot, off = [], []
    for f in range(dur + 1):
        for _ in range(4):  # substeps
            ddphi = -w * w * (phi - TH[f]) - 2 * zeta * w * dphi - gain * acc[f, 0] / L
            dphi += ddphi * dt / 4; phi += dphi * dt / 4
            ddy = -(1.2 * w) ** 2 * y - 2 * zeta * (1.2 * w) * dy - gain * acc[f, 1]
            dy += ddy * dt / 4; y += dy * dt / 4
        rot.append(phi - TH[f]); off.append(y)
    rot, off = np.clip(np.array(rot), -rmax, rmax), np.clip(np.array(off), -ymax, ymax)
    n = min(10, dur // 4)
    fade = np.ones(dur + 1)
    fade[-n:] = np.linspace(1, 0, n) ** 2
    return np.arange(dur + 1), rot * fade, off * fade, h


def key_track(obj_id: str, prop: str, frames, vals, step: int = 2, base: float = 0.0) -> str:
    sel = [f for f in frames if f % step == 0 or f == frames[-1]]
    kf = "".join(f'<KeyFrameDouble value="{base + vals[f]:.6f}" frame="{f}" interpolationType="linear"/>' for f in sel)
    return f'<KeyedObject objectId="{obj_id}"><KeyedProperty property="{prop}">{kf}</KeyedProperty></KeyedObject>'


def smooth_fill(ctx: np.ndarray, hole: np.ndarray, sigma: float = 10.0, seed: int = 34, grain: float = 1.2,
                fold: float = 0.0) -> np.ndarray:
    """normalized-convolution fill (Gaussian-weighted mean of known context) for large holes: no Telea streaks/blobs.
    fold>0 adds faint vertical cloth folds (sin of x) of that amplitude."""
    known = ((ctx[:, :, 3] >= 200) & ~hole).astype(np.float32)
    rgb = ctx[:, :, :3].astype(np.float32)
    num = cv2.GaussianBlur(rgb * known[..., None], (0, 0), sigma)
    den = cv2.GaussianBlur(known, (0, 0), sigma)[..., None]
    fill = num / np.maximum(den, 1e-4)
    small = den[..., 0] < 0.02
    if small.any():  # far from context: wider kernel
        num2 = cv2.GaussianBlur(rgb * known[..., None], (0, 0), sigma * 3)
        den2 = cv2.GaussianBlur(known, (0, 0), sigma * 3)[..., None]
        fill[small] = (num2 / np.maximum(den2, 1e-4))[small]
    H, W = hole.shape
    rng = np.random.default_rng(seed)
    fill = fill + rng.normal(0, grain, (H, W, 1))
    if fold > 0:
        xs = np.arange(W)[None, :, None]
        fill = fill + fold * np.sin(xs / 5.5 + 0.7) * np.sin(np.arange(H)[:, None, None] / 37.0 + 1.1)
    out = ctx.copy()
    out[hole, :3] = np.clip(fill[hole], 0, 255).astype(np.uint8)
    out[hole, 3] = 255
    return out


def crease_fill(ctx: np.ndarray, hole: np.ndarray, sigma: float = 8.0, seed: int = 34, grain: float = 1.0,
                wv: float = 0.65) -> np.ndarray:
    """shorts creases are vertical: per column, linearly interpolate the nearest known fabric above/below the hole
    (median of 3 px), blend (wv) with the normalized-conv mean, then match the hole-rim mean.  Procedural."""
    known = (ctx[:, :, 3] >= 200) & ~hole
    base = smooth_fill(ctx, hole, sigma=sigma, seed=seed, grain=0.0)[:, :, :3].astype(np.float32)
    H, W = hole.shape
    vert = base.copy()
    rgb = ctx[:, :, :3].astype(np.float32)
    for x in range(W):
        ys = np.nonzero(hole[:, x])[0]
        if not len(ys):
            continue
        # contiguous runs
        runs = np.split(ys, np.nonzero(np.diff(ys) > 1)[0] + 1)
        for r in runs:
            y0, y1 = r[0], r[-1]
            up = [y for y in range(y0 - 1, max(-1, y0 - 6), -1) if known[y, x]][:3]
            dn = [y for y in range(y1 + 1, min(H, y1 + 6)) if known[y, x]][:3]
            if up and dn:
                cu, cd = np.median(rgb[up, x], 0), np.median(rgb[dn, x], 0)
                t = (r - y0 + 1) / (y1 - y0 + 2)
                vert[r, x] = (1 - t)[:, None] * cu + t[:, None] * cd
            elif up or dn:
                vert[r, x] = np.median(rgb[up or dn, x], 0)
    vert = cv2.GaussianBlur(vert, (0, 0), sigmaX=0.8, sigmaY=2.0)
    fill = wv * vert + (1 - wv) * base
    rim = (cv2.dilate(hole.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0) & known
    if rim.any():
        fill += (rgb[rim].mean(0) - fill[hole].mean(0)) * 0.8
    rng = np.random.default_rng(seed)
    fill += rng.normal(0, grain, (H, W, 1))
    out = ctx.copy()
    out[hole, :3] = np.clip(fill[hole], 0, 255).astype(np.uint8)
    out[hole, 3] = 255
    return out
