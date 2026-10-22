#!/usr/bin/env python3
"""ROUND35 helpers: mother-grid paste, skin/hair backfill, license, build hook."""
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
META_BOXES = L10.META
BASE = "deterministic source-pixel rig layer derived from user supplied full-body mother"
S = 1300.0 / 1536.0
OX = (960.0 - 1024 * S) / 2.0
OY = 0.0

# mother-grid origin (texel) — keep in sync with round34_common.ORIGIN where shared
ORIGIN = {
    "belt-band.png": (418, 473),
    "waist-backfill.png": (418, 473),
    "belt-id.png": (435, 509),
    "belt-pouch.png": (553, 507),
    "shorts.png": (379, 507),
    "shorts-side-orange.png": (379, 507),
    "torso-tank.png": (410, 332),
    "coat-r-front.png": (594, 320),
    "coat-l-front.png": (205, 320),  # approx; refined when needed
    "fullbody-base-no-head-arms.png": (0, 0),
    "body-backfill.png": (0, 0),
    "choker.png": (435, 305),  # legacy tank-neckline box; R35a rewrites
    "mouth.png": (450, 250),
    "head.png": (250, 0),
    "hair-lock-l.png": (354, 96),
    "hair-lock-r.png": (572, 108),
    "hair-bow.png": (572, 108),  # R33: same canvas as lock-r
    "hair-back-l.png": (364, 244),
    "hair-back-r.png": (571, 267),
}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load(name: str) -> np.ndarray:
    return np.array(Image.open(SVG / name).convert("RGBA"))


def save(name: str, im: np.ndarray):
    Image.fromarray(im.astype(np.uint8)).save(SVG / name, optimize=True)


def art(mx: float, my: float):
    return OX + mx * S, my * S


def boxes() -> dict:
    return json.loads(META_BOXES.read_text())["boxes"]


def set_box(name: str, box: list[int]):
    data = json.loads(META_BOXES.read_text())
    data["boxes"][name] = box
    META_BOXES.write_text(json.dumps(data, indent=2) + "\n")


def brand_orange(im: np.ndarray) -> np.ndarray:
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    return (a >= 8) & (r > 170) & (g > 60) & (g < 180) & (b < 100) & ((r - g) > 40) & ((r - b) > 70)


def loose_orange(im: np.ndarray) -> np.ndarray:
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    return (a >= 8) & (r > 155) & (g > 45) & (g < 205) & (b < 140) & ((r - g) > 28) & ((r - b) > 35)


def backfill_skin(im: np.ndarray, hole: np.ndarray, seed_mean=None) -> np.ndarray:
    """Fill hole with nearby peach skin (no Telea orange/dark bleed)."""
    a = im[:, :, 3]
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    skin = (a >= 180) & ~hole & (r > 190) & (g > 140) & (b > 100) & ((r - b) < 100)
    mean = seed_mean if seed_mean is not None else (
        im[:, :, :3][skin].mean(0) if skin.any() else np.array([250.0, 220.0, 205.0])
    )
    rgb = im[:, :, :3].copy()
    ys, xs = np.where(hole)
    for y, x in zip(ys, xs):
        y0, y1 = max(0, y - 6), min(im.shape[0], y + 7)
        x0, x1 = max(0, x - 6), min(im.shape[1], x + 7)
        patch = skin[y0:y1, x0:x1]
        rgb[y, x] = im[y0:y1, x0:x1][:, :, :3][patch].mean(0) if patch.any() else mean
    mask = hole.astype(np.uint8) * 255
    inp = cv2.inpaint(rgb, mask, 3, cv2.INPAINT_TELEA)
    rr, gg, bb = inp[:, :, 0].astype(np.float32), inp[:, :, 1].astype(np.float32), inp[:, :, 2].astype(np.float32)
    bad = hole & (((rr < 120) & ((rr + gg + bb) < 360)) | ((rr > 170) & ((rr - bb) > 55) & (bb < 130) & (gg > 90)))
    inp[bad] = mean.astype(np.uint8)
    blur = cv2.bilateralFilter(inp, 5, 35, 35)
    out = im.copy()
    out[hole, :3] = blur[hole]
    # keep original alpha (opaque where coverage was)
    return out


def backfill_hair(im: np.ndarray, hole: np.ndarray) -> np.ndarray:
    a = im[:, :, 3]
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    lum = (r + g + b) / 3
    hair = (a >= 8) & ~hole & (lum < 140) & (r < 160) & (b < 120)
    if not hair.any():
        hair = (a >= 8) & ~hole & (lum < 180)
    mean = im[:, :, :3][hair].mean(0) if hair.any() else np.array([55.0, 35.0, 30.0])
    rgb = im[:, :, :3].copy()
    ys, xs = np.where(hole)
    for y, x in zip(ys, xs):
        y0, y1 = max(0, y - 6), min(im.shape[0], y + 7)
        x0, x1 = max(0, x - 6), min(im.shape[1], x + 7)
        patch = hair[y0:y1, x0:x1]
        rgb[y, x] = im[y0:y1, x0:x1][:, :, :3][patch].mean(0) if patch.any() else mean
    mask = hole.astype(np.uint8) * 255
    inp = cv2.inpaint(rgb, mask, 3, cv2.INPAINT_TELEA)
    rr, gg, bb = inp[:, :, 0].astype(np.float32), inp[:, :, 1].astype(np.float32), inp[:, :, 2].astype(np.float32)
    still = hole & (rr > 150) & ((rr - gg) > 25) & ((rr - bb) > 30)
    inp[still] = mean.astype(np.uint8)
    blur = cv2.bilateralFilter(inp, 5, 40, 40)
    out = im.copy()
    out[hole, :3] = blur[hole]
    return out


def window(src_name: str, src: np.ndarray, dst_name: str, dst_shape) -> np.ndarray:
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


def put(dst_name: str, dst: np.ndarray, src_name: str, patch: np.ndarray, mask: np.ndarray) -> int:
    sx, sy = ORIGIN[src_name]
    dx, dy = ORIGIN[dst_name]
    ox, oy = sx - dx, sy - dy
    ys, xs = np.nonzero(mask)
    X, Y = xs + ox, ys + oy
    ok = (X >= 0) & (Y >= 0) & (X < dst.shape[1]) & (Y < dst.shape[0])
    dst[Y[ok], X[ok]] = patch[ys[ok], xs[ok]]
    return int(ok.sum())


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


def orange_components(im: np.ndarray, min_area: int = 12) -> np.ndarray:
    ora = brand_orange(im)
    n, lab, st, _ = cv2.connectedComponentsWithStats(ora.astype(np.uint8), 8)
    keep = np.zeros_like(ora)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= min_area:
            keep |= lab == i
    dil = cv2.dilate(keep.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    fringe = dil & (a >= 1) & ~keep
    warm = (r > 140) & ((r - b) > 25) & ((r - g) > 15) & (g < 210)
    keep |= fringe & warm
    return keep
