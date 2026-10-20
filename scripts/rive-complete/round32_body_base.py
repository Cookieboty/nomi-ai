#!/usr/bin/env python3
"""ROUND32b: redraw bare-body base + neutral underlayer (sports bra + bike shorts).

Replaces the R31 crude flat fill / arm capsules with:
  - body-backfill.png: anatomically shaped torso/hip skin, master-seeded Telea
    inpaint + soft cel shading + thin line art; exposed face/neck/legs/hands
    outside the garment-under mask stay untouched (byte-identical elsewhere).
  - arm-{l,r}-under-skin.png: tapered arm skins from sleeve footprint, width
    profile from shoulder→wrist, shaded from upper-skin / palm means.
  - underlayer-top.png / underlayer-bottom.png: dark form-fitting SFW sports
    bra + bike shorts as separate garment layers (cloned tank/shorts meshes).

Draw order (later Image = behind in this scene): coat/sleeves … shorts … tank
… underlayer … body.backfill. So: body → underlayer → tank → shorts → coat.

Idempotent via MARK + license sha notes.
"""
from __future__ import annotations
import hashlib, json, os, re, shutil
from pathlib import Path
import numpy as np
import cv2
from PIL import Image

import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT = L10.PROJECT
ROOT = L10.ROOT
SCENE = PROJECT / "scene.rml"
SVG = PROJECT / "reference" / "svg-rig"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
MASTER = PROJECT / "source-nomi-master.png"
MARK = "<!-- ROUND32 body-base -->"
OUT_SCRATCH = Path("/workspace/scratch/rive-bone-rig/v32/art")
OUT_SCRATCH.mkdir(parents=True, exist_ok=True)

BASE_NOTE = "deterministic source-pixel rig layer derived from user supplied full-body mother"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def skin_mask(rgb, a, thr_a=8):
    r, g, b = rgb[:, :, 0].astype(np.float32), rgb[:, :, 1].astype(np.float32), rgb[:, :, 2].astype(np.float32)
    orange = (r > 180) & (g > 80) & (g < 180) & (b < 100) & ((r - g) > 40)
    return (a >= thr_a) & (r > 150) & (g > 100) & (b > 60) & (r > g) & ((r - b) > 20) & ((r - g) < 70) & ~orange


def orange_mask(rgb, a, thr_a=8):
    r, g, b = rgb[:, :, 0].astype(np.float32), rgb[:, :, 1].astype(np.float32), rgb[:, :, 2].astype(np.float32)
    return (a >= thr_a) & (r > 180) & (g > 80) & (g < 180) & (b < 100) & ((r - g) > 40)


def dark_mask(rgb, a, thr_a=8, vmax=130):
    r, g, b = [rgb[:, :, i].astype(np.float32) for i in range(3)]
    return (a >= thr_a) & (np.maximum(np.maximum(r, g), b) <= vmax)


def feather_alpha(rgb_a, solid_dist=2.0):
    m = rgb_a[:, :, 3] > 0
    dist = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
    out = rgb_a.copy()
    out[:, :, 3] = np.where(
        m,
        np.where(dist >= solid_dist, 255, np.clip(dist / solid_dist * 255, 0, 255).astype(np.uint8)),
        0,
    )
    return out


def place_crop(canvas, crop, origin, alpha_thr=8):
    """Stamp crop onto full-size canvas at mother origin (x0,y0)."""
    x0, y0 = origin
    th, tw = crop.shape[:2]
    h, w = canvas.shape[:2]
    y1, x1 = min(h, y0 + th), min(w, x0 + tw)
    region = crop[: y1 - y0, : x1 - x0]
    m = region[:, :, 3] >= alpha_thr
    canvas[y0:y1, x0:x1][m] = region[m]
    return canvas


def crop_box(name: str):
    meta = json.loads((SVG / "rig-meta.json").read_text())
    x0, y0, x1, y1 = meta["boxes"][name]
    return x0, y0, x1, y1


def build_body_skin():
    """Anatomical torso/hip bare skin under garments."""
    master = np.array(Image.open(MASTER).convert("RGBA"))
    bf0 = np.array(Image.open(SVG / "body-backfill.png").convert("RGBA"))
    h, w = bf0.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    sk = skin_mask(master[:, :, :3], master[:, :, 3], 128)
    dark = dark_mask(master[:, :, :3], master[:, :, 3], 128, 140)
    ora = orange_mask(master[:, :, :3], master[:, :, 3], 128)

    # Garment footprints in mother space
    garment = np.zeros((h, w), bool)
    for key in ("torso-tank", "shorts", "sleeve-l-full", "sleeve-r-full"):
        p = SVG / f"{key}.png"
        if not p.exists():
            continue
        box = crop_box(key)
        crop = np.array(Image.open(p).convert("RGBA"))
        x0, y0 = box[0], box[1]
        th, tw = crop.shape[:2]
        y1, x1 = min(h, y0 + th), min(w, x0 + tw)
        garment[y0:y1, x0:x1] |= crop[: y1 - y0, : x1 - x0, 3] >= 40
    # coat fronts: optional json origin
    for side in "lr":
        jp = SVG / f"coat-{side}-front.json"
        pp = SVG / f"coat-{side}-front.png"
        if not pp.exists():
            continue
        crop = np.array(Image.open(pp).convert("RGBA"))
        if jp.exists():
            meta_c = json.loads(jp.read_text())
            x0 = int(meta_c.get("x0") or meta_c.get("x") or meta_c.get("origin", [0, 0])[0])
            y0 = int(meta_c.get("y0") or meta_c.get("y") or meta_c.get("origin", [0, 0])[1])
        else:
            # skip if no placement — mother dark/orange band covers coat body
            continue
        th, tw = crop.shape[:2]
        y1, x1 = min(h, y0 + th), min(w, x0 + tw)
        garment[y0:y1, x0:x1] |= crop[: y1 - y0, : x1 - x0, 3] >= 40

    # Also include master dark/orange in torso band (clothes baked in mother)
    torso_band = (xx >= 380) & (xx <= 644) & (yy >= 300) & (yy <= 780)
    garment |= torso_band & (dark | ora)
    # Exclude true skin already showing (neck, shoulders, thighs) from "needs fill" —
    # but INCLUDE them as seeds. Fill mask = garment OR previous backfill, closed.
    cur = bf0[:, :, 3] >= 8
    fill_m = (garment | cur) & torso_band
    # Expand slightly under clothes so no gaps at hem
    fill_m = cv2.dilate(fill_m.astype(np.uint8), np.ones((7, 7), np.uint8), 1).astype(bool)
    fill_m = cv2.morphologyEx(fill_m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((21, 21), np.uint8)).astype(bool)
    # Fill enclosed holes
    mask = (fill_m.astype(np.uint8) * 255)
    n, lab, stats, _ = cv2.connectedComponentsWithStats((mask == 0).astype(np.uint8), 4)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_LEFT] == 0 or stats[i, cv2.CC_STAT_TOP] == 0:
            continue
        if stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] >= w:
            continue
        if stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT] >= h:
            continue
        if stats[i, cv2.CC_STAT_AREA] < 12000:
            mask[lab == i] = 255
    fill_m = mask > 0

    # Anatomical waist pinch: narrow mask around mid-torso using cosine profile
    # Keep shoulder width ~ master tank, waist thinner, hips wider
    cy_chest, cy_waist, cy_hip = 380, 520, 680
    # Estimate half-widths from garment columns
    def half_w_at(y0, y1):
        rows = fill_m[y0:y1]
        if not rows.any():
            return 70
        widths = []
        for row in rows:
            xs = np.where(row)[0]
            if len(xs) >= 2:
                widths.append((xs[-1] - xs[0]) / 2.0)
        return float(np.median(widths)) if widths else 70.0

    hw_chest = half_w_at(350, 420)
    hw_waist = half_w_at(480, 560) * 0.92  # slight pinch toward anime waist
    hw_hip = half_w_at(640, 720)
    cx = 512.0
    # Rebuild smoother torso silhouette with tapered widths
    torso = np.zeros((h, w), bool)
    for y in range(300, 780):
        if y < cy_waist:
            t = (y - cy_chest) / max(cy_waist - cy_chest, 1)
            t = np.clip(t, 0, 1)
            # smoothstep
            t = t * t * (3 - 2 * t)
            hw = hw_chest * (1 - t) + hw_waist * t
        else:
            t = (y - cy_waist) / max(cy_hip - cy_waist, 1)
            t = np.clip(t, 0, 1)
            t = t * t * (3 - 2 * t)
            hw = hw_waist * (1 - t) + hw_hip * t
        # shoulder flare above chest
        if y < cy_chest:
            t = (cy_chest - y) / 80.0
            hw = hw_chest + 8 * np.clip(t, 0, 1)
        x0 = int(cx - hw)
        x1 = int(cx + hw)
        torso[y, max(0, x0) : min(w, x1)] = True
    # Combine: prefer anatomical torso inside garment band, keep previous shoulder reach
    fill_m = (torso & (yy >= 310) & (yy <= 760)) | (fill_m & (yy >= 700))  # keep hip extension
    fill_m = cv2.morphologyEx(fill_m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)).astype(bool)
    # Don't cover face/hair
    fill_m &= yy >= 310
    # Don't paint over existing good leg skin region below shorts hem as replacement —
    # actually we NEED hip/upper-thigh under shorts; legs start ~666. Keep to y<=760.

    # Seeds: real master skin near neck, shoulders, thighs
    seeds = np.zeros((h, w), bool)
    seeds |= sk & (yy >= 300) & (yy <= 420) & (xx >= 430) & (xx <= 594)
    seeds |= sk & (yy >= 680) & (yy <= 780) & (xx >= 400) & (xx <= 624)
    for side, origin in (("l", (315, 250)), ("r", (554, 250))):
        sh = np.array(Image.open(SVG / f"arm-{side}-shoulder-skin.png").convert("RGBA"))
        x0, y0 = origin
        th, tw = sh.shape[:2]
        y1, x1 = min(h, y0 + th), min(w, x0 + tw)
        region = sh[: y1 - y0, : x1 - x0]
        seeds[y0:y1, x0:x1] |= skin_mask(region[:, :, :3], region[:, :, 3])

    # Inpaint: start from master RGB, mark non-seed fill pixels as unknown
    bgr = cv2.cvtColor(master[:, :, :3], cv2.COLOR_RGB2BGR)
    unknown = fill_m & ~seeds
    # Also treat garment-colored pixels inside fill as unknown even if "skin-ish" false
    unknown |= fill_m & (dark | ora)
    inpaint_mask = (unknown.astype(np.uint8) * 255)
    # Dilate slightly so Telea has work
    filled = cv2.inpaint(bgr, inpaint_mask, 8, cv2.INPAINT_TELEA)
    filled = cv2.cvtColor(filled, cv2.COLOR_BGR2RGB).astype(np.float32)

    # Vertical skin tone gradient from neck→hip using seed means
    chest = master[:, :, :3][seeds & (yy < 450)].mean(0) if (seeds & (yy < 450)).any() else np.array([248.0, 210.0, 190.0])
    hip = master[:, :, :3][seeds & (yy > 650)].mean(0) if (seeds & (yy > 650)).any() else np.array([240.0, 200.0, 180.0])
    t = np.clip((yy.astype(float) - 320) / 440, 0, 1)
    base = chest[None, None, :] * (1 - t[..., None]) + hip[None, None, :] * t[..., None]

    # Soft cel shading: center highlight, side AO, under-breast / waist crease
    nx = (xx - cx) / max(hw_chest, 1)
    radial = np.clip(1.0 - 0.10 * np.clip(nx, -1.5, 1.5) ** 2, 0.85, 1.0)
    # subtle belly AO below waist
    belly = 1.0 - 0.06 * np.exp(-((yy - 560) / 40.0) ** 2) * np.exp(-(nx ** 2) / 0.5)
    # collarbone-ish band
    collar = 1.0 - 0.05 * np.exp(-((yy - 360) / 18.0) ** 2) * np.exp(-(nx ** 2) / 0.8)
    shade = radial * belly * collar

    # Blend inpaint with gradient base (inpaint carries local hue from seeds)
    rgb = filled * 0.72 + base * 0.28
    rgb = rgb * shade[..., None]
    # Keep seeds crisp from master
    rgb[seeds] = master[:, :, :3][seeds].astype(np.float32)
    # Mild bilateral for cel softness inside mask
    rgb_u8 = np.clip(rgb, 0, 255).astype(np.uint8)
    soft = cv2.bilateralFilter(rgb_u8, 5, 40, 40)
    rgb_u8 = np.where(fill_m[..., None], soft, rgb_u8)
    rgb_u8[seeds] = master[:, :, :3][seeds]

    out = np.zeros_like(bf0)
    out[:, :, :3] = rgb_u8
    out[:, :, 3] = np.where(fill_m, 255, 0).astype(np.uint8)

    # Thin line art on silhouette (dark brown, matching master line hue ~70,45,40)
    edge = cv2.Canny(fill_m.astype(np.uint8) * 255, 50, 120)
    edge = cv2.dilate(edge, np.ones((2, 2), np.uint8), 1)
    # only outer edge: where dist small
    dist = cv2.distanceTransform(fill_m.astype(np.uint8), cv2.DIST_L2, 5)
    rim = (edge > 0) & (dist <= 2.5) & fill_m
    line_col = np.array([92.0, 58.0, 48.0])
    out[rim, :3] = (out[rim, :3].astype(float) * 0.35 + line_col * 0.65).astype(np.uint8)

    out = feather_alpha(out, 1.8)
    Image.fromarray(out).save(SVG / "body-backfill.png", optimize=True)
    Image.fromarray(out).save(OUT_SCRATCH / "body-backfill-r32.png", optimize=True)

    om = out[:, :, 3] >= 8
    skn = skin_mask(out[:, :, :3], out[:, :, 3])
    dark_n = int((om & (out[:, :, 0] < 90) & (out[:, :, 1] < 90) & (out[:, :, 2] < 90)).sum())
    return dict(
        opaque=int(om.sum()),
        skin=int(skn.sum()),
        dark=dark_n,
        chest=[round(float(x), 1) for x in chest],
        hip=[round(float(x), 1) for x in hip],
        hw_chest=round(hw_chest, 1),
        hw_waist=round(hw_waist, 1),
        hw_hip=round(hw_hip, 1),
    )


def build_arm_under(side: str):
    """Tapered arm skin inside sleeve footprint; continuous with upper-skin & hand."""
    sl = np.array(Image.open(SVG / f"sleeve-{side}-full.png").convert("RGBA"))
    up = np.array(Image.open(SVG / f"arm-{side}-upper-skin.png").convert("RGBA"))
    palm = np.array(Image.open(SVG / f"hand-{side}-palm.png").convert("RGBA"))
    us = skin_mask(up[:, :, :3], up[:, :, 3], 200)
    ps = skin_mask(palm[:, :, :3], palm[:, :, 3], 200)
    mean_u = up[:, :, :3][us].mean(0) if us.any() else np.array([248.0, 212.0, 195.0])
    mean_p = palm[:, :, :3][ps].mean(0) if ps.any() else mean_u
    solid = sl[:, :, 3] >= 200
    h, w = solid.shape
    # Centerline from solid columns
    cy = np.full(h, np.nan)
    half = np.full(h, np.nan)
    for y in range(h):
        xs = np.where(solid[y])[0]
        if len(xs) < 4:
            continue
        cy[y] = 0.5 * (xs[0] + xs[-1])
        half[y] = 0.5 * (xs[-1] - xs[0])
    # Interpolate gaps
    valid = ~np.isnan(cy)
    if valid.sum() < 10:
        # fallback capsule
        return _arm_capsule_fallback(side, sl, mean_u)
    ys = np.where(valid)[0]
    cy = np.interp(np.arange(h), ys, cy[ys])
    half_sl = np.interp(np.arange(h), ys, half[ys])
    # Target half-width: ~55% of sleeve at top (upper arm), taper to ~35% near wrist
    t = np.linspace(0, 1, h)
    # measure upper-skin width roughly
    up_w = max(8.0, (up[:, :, 3] >= 200).sum(1).max() / 2.0) if (up[:, :, 3] >= 200).any() else 18.0
    palm_w = max(6.0, (palm[:, :, 3] >= 200).sum(1).max() / 2.0) if (palm[:, :, 3] >= 200).any() else 12.0
    # Map along sleeve: top third → upper width, bottom → wrist
    target = up_w * (1 - t) + palm_w * t
    # Never exceed inset from sleeve edge
    inset = 12.0
    target = np.minimum(target, half_sl - inset)
    target = np.maximum(target, 6.0)

    out = np.zeros_like(sl)
    for y in range(h):
        if not solid[y].any():
            continue
        c = cy[y]
        hw = target[y]
        x0 = int(np.floor(c - hw))
        x1 = int(np.ceil(c + hw))
        for x in range(max(0, x0), min(w, x1 + 1)):
            if not solid[y, x]:
                continue
            # elliptical falloff for soft limb edge
            u = (x - c) / hw
            if abs(u) > 1:
                continue
            # round cross-section shade
            shade = 1.0 - 0.14 * u * u
            # vertical: slightly darker toward wrist + blend means
            vt = y / max(h - 1, 1)
            col = mean_u * (1 - vt) + mean_p * vt
            # soft highlight on outer side (light from upper-front)
            outer = 1.0 if side == "l" else -1.0  # left arm: light on +x (toward body?); keep mild
            hl = 1.0 + 0.04 * (-u * outer)
            out[y, x, :3] = np.clip(col * shade * hl, 0, 255)
            out[y, x, 3] = 255

    # Line art rim inside solid
    arm_m = out[:, :, 3] >= 8
    dist = cv2.distanceTransform(arm_m.astype(np.uint8), cv2.DIST_L2, 5)
    edge = (cv2.Canny(arm_m.astype(np.uint8) * 255, 40, 100) > 0) & (dist <= 2.0)
    out[edge, :3] = (out[edge, :3].astype(float) * 0.4 + np.array([92.0, 58.0, 48.0]) * 0.6).astype(np.uint8)

    out = feather_alpha(out, 1.5)
    out[sl[:, :, 3] < 200, 3] = 0
    dest = SVG / f"arm-{side}-under-skin.png"
    Image.fromarray(out).save(dest, optimize=True)
    Image.fromarray(out).save(OUT_SCRATCH / f"arm-{side}-under-skin-r32.png", optimize=True)
    meta = dict(
        side=side,
        opaque=int((out[:, :, 3] >= 8).sum()),
        mean_u=[round(float(x), 1) for x in mean_u],
        mean_p=[round(float(x), 1) for x in mean_p],
        sha256=sha(dest),
    )
    (SVG / f"arm-{side}-under-skin.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def _arm_capsule_fallback(side, sl, mean):
    solid = sl[:, :, 3] >= 200
    d2 = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    arm_m = (d2 >= 14) & solid
    out = np.zeros_like(sl)
    h, w = solid.shape
    for y in range(h):
        xs = np.where(arm_m[y])[0]
        if len(xs) < 2:
            continue
        cx = (xs[0] + xs[-1]) / 2.0
        half = max((xs[-1] - xs[0]) / 2.0, 1.0)
        for x in xs:
            t = abs(x - cx) / half
            shade = 1.0 - 0.12 * min(t, 1.0) ** 2
            out[y, x, :3] = np.clip(mean * shade, 0, 255)
            out[y, x, 3] = 255
    out = feather_alpha(out, 1.5)
    out[sl[:, :, 3] < 200, 3] = 0
    dest = SVG / f"arm-{side}-under-skin.png"
    Image.fromarray(out).save(dest, optimize=True)
    return dict(side=side, opaque=int((out[:, :, 3] >= 8).sum()), fallback=True)


def build_underlayer_top():
    """Dark sports-bra / crop top on tank canvas (same box), form-fitting."""
    tank = np.array(Image.open(SVG / "torso-tank.png").convert("RGBA"))
    h, w = tank.shape[:2]
    # Use tank alpha as outer bound, shrink inward for bra shape (higher neck cut, shorter hem)
    solid = tank[:, :, 3] >= 180
    dist = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    # Bra covers upper ~70% of tank height, full width inset 2px
    yy, xx = np.mgrid[0:h, 0:w]
    bra = solid & (dist >= 2) & (yy <= int(h * 0.78))
    # Scoop neck: remove top-center ellipse
    cx, cy = w / 2.0, h * 0.08
    neck = ((xx - cx) / (w * 0.28)) ** 2 + ((yy - cy) / (h * 0.22)) ** 2 <= 1.0
    bra &= ~neck
    # Racerback-ish: slightly thicker straps (keep top corners)
    out = np.zeros_like(tank)
    # Fabric color: near-black charcoal with soft highlight
    base = np.array([28.0, 26.0, 30.0])
    for y in range(h):
        xs = np.where(bra[y])[0]
        if len(xs) < 2:
            continue
        c = 0.5 * (xs[0] + xs[-1])
        for x in xs:
            u = (x - c) / max((xs[-1] - xs[0]) / 2.0, 1)
            shade = 1.0 + 0.15 * (1 - u * u)  # center highlight
            # bottom hem darker
            vt = y / max(h - 1, 1)
            hem = 1.0 - 0.12 * max(0, vt - 0.55) / 0.45
            out[y, x, :3] = np.clip(base * shade * hem, 0, 255)
            out[y, x, 3] = 255
    # Thin edge line
    edge = (cv2.Canny(bra.astype(np.uint8) * 255, 40, 100) > 0)
    out[edge, :3] = (18, 16, 20)
    out = feather_alpha(out, 1.2)
    dest = SVG / "underlayer-top.png"
    Image.fromarray(out).save(dest, optimize=True)
    Image.fromarray(out).save(OUT_SCRATCH / "underlayer-top.png", optimize=True)
    return dict(opaque=int((out[:, :, 3] >= 8).sum()), sha256=sha(dest), box="torso-tank")


def build_underlayer_bottom():
    """Bike-shorts style underwear on shorts canvas, form-fitting, shorter than outer shorts."""
    shorts = np.array(Image.open(SVG / "shorts.png").convert("RGBA"))
    h, w = shorts.shape[:2]
    solid = shorts[:, :, 3] >= 180
    dist = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    yy, xx = np.mgrid[0:h, 0:w]
    # Inset and trim lower hem (~85% height) for bike-short length under outer shorts
    bike = solid & (dist >= 3) & (yy <= int(h * 0.88))
    # Soft crotch seam darkening
    out = np.zeros_like(shorts)
    base = np.array([32.0, 30.0, 34.0])
    cx = w / 2.0
    for y in range(h):
        xs = np.where(bike[y])[0]
        if len(xs) < 2:
            continue
        for x in xs:
            u = (x - cx) / max(w / 2.0, 1)
            shade = 1.0 + 0.12 * (1 - min(u * u, 1))
            # center seam
            seam = 1.0 - 0.18 * np.exp(-((x - cx) / 6.0) ** 2)
            out[y, x, :3] = np.clip(base * shade * seam, 0, 255)
            out[y, x, 3] = 255
    edge = cv2.Canny(bike.astype(np.uint8) * 255, 40, 100) > 0
    out[edge, :3] = (16, 14, 18)
    out = feather_alpha(out, 1.2)
    dest = SVG / "underlayer-bottom.png"
    Image.fromarray(out).save(dest, optimize=True)
    Image.fromarray(out).save(OUT_SCRATCH / "underlayer-bottom.png", optimize=True)
    return dict(opaque=int((out[:, :, 3] >= 8).sum()), sha256=sha(dest), box="shorts")


def insert_underlayer_images(scene: str) -> str:
    """Clone tank/shorts meshes onto underlayer Image nodes; draw behind tank/shorts."""
    if "full.underlayer.top.image" in scene and "full.underlayer.bottom.image" in scene:
        return scene
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})

    # Assets
    for aname, frel, after in (
        ("fullbody-underlayer-top", "reference/svg-rig/underlayer-top.png", "fullbody-torso-tank"),
        ("fullbody-underlayer-bottom", "reference/svg-rig/underlayer-bottom.png", "fullbody-shorts"),
    ):
        if f'name="{aname}"' in scene:
            continue
        m = re.search(rf'<ImageAsset name="{after}"[^/]*/>', scene)
        if not m:
            # fallback by file
            key = "torso-tank" if "top" in aname else "shorts"
            m = re.search(rf'<ImageAsset [^>]*file="reference/svg-rig/{key}\.png"[^/]*/>', scene)
        aid = R8.nid("asset")
        tag = f'<ImageAsset name="{aname}" file="{frel}" id="{aid}"/>'
        scene = scene[: m.end()] + "\n    " + tag + scene[m.end() :]
        print(f"asset {aname} id={aid}")

    def clone_image(src_name: str, new_name: str, asset_name: str, insert_after: str):
        nonlocal scene
        if new_name in scene:
            return
        a, b = R8.find_elem(scene, "Image", src_name)
        block = scene[a:b]
        am = re.search(rf'<ImageAsset name="{asset_name}"[^>]*id="([^"]+)"', scene)
        asset = am.group(1)
        iid = R8.nid("image")
        mesh = re.search(r"<Mesh\b.*</Mesh>", block, re.S).group(0)
        # rename mesh internals away from src
        mesh2 = mesh.replace(src_name, new_name)
        mesh2 = re.sub(r'\bid="[^"]+"', lambda mo: f'id="{R8.nid("mesh")}"', mesh2)
        xml = (
            f'<Image name="{new_name}" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
            f'scaleX="1" scaleY="1" id="{iid}">{mesh2}</Image>'
        )
        da, db = R8.find_elem(scene, "Image", insert_after)
        # Insert AFTER insert_after so underlayer draws behind it (later = behind)
        scene = scene[:db] + xml + scene[db:]
        print(f"inserted {new_name} after {insert_after}")

    # tank then underlayer-top behind it; shorts then underlayer-bottom behind it
    clone_image("full.torso.tank.image", "full.underlayer.top.image", "fullbody-underlayer-top", "full.torso.tank.image")
    clone_image("full.shorts.image", "full.underlayer.bottom.image", "fullbody-underlayer-bottom", "full.shorts.image")
    return scene


def update_license(body_stats, arm_stats, top_stats, bot_stats):
    lic = json.load(open(LICENSE))
    entries = {
        "body-backfill.png": BASE_NOTE
        + "; ROUND32: redrawn anatomical torso/hip bare-skin (master-seed Telea + cel shade + line); replaces R31 flat fill; derived not AI-generated",
        "arm-l-under-skin.png": BASE_NOTE
        + "; ROUND32: tapered arm under-sleeve skin (width profile upper→wrist from upper-skin/palm means); replaces R31 capsule",
        "arm-r-under-skin.png": BASE_NOTE
        + "; ROUND32: tapered arm under-sleeve skin (width profile upper→wrist from upper-skin/palm means); replaces R31 capsule",
        "underlayer-top.png": BASE_NOTE
        + "; ROUND32: new neutral sports-bra/crop underlayer (procedural dark fabric on tank canvas); SFW form-fitting",
        "underlayer-bottom.png": BASE_NOTE
        + "; ROUND32: new bike-shorts underlayer (procedural dark fabric on shorts canvas); SFW form-fitting",
    }
    for name, method in entries.items():
        path = SVG / name
        if not path.exists():
            continue
        e = lic["assets"].setdefault("reference/svg-rig/" + name, {})
        e.update(
            sha256=sha(path),
            bytes=path.stat().st_size,
            ai_generated=False,
            in_scene=True,
            method=method,
            round="R32",
        )
    note = lic.get("note", "")
    if "ROUND32" not in note:
        lic["note"] = (
            note
            + " ROUND32: anatomical bare-body backfill + tapered arm-under-skin; neutral underlayer top/bottom layers; finger rest loop-safe (R32a)."
        )
    lic["round32"] = {
        "body": body_stats,
        "arms": arm_stats,
        "underlayer_top": top_stats,
        "underlayer_bottom": bot_stats,
    }
    LICENSE.write_text(json.dumps(lic, indent=2, ensure_ascii=False) + "\n")


def main():
    scene = SCENE.read_text(encoding="utf-8")
    import round32_body_paint as P
    print("ROUND32 body paint…")
    body, arms, top, bot = P.paint_all()
    print("body", body)
    print("arms", arms)
    print("underlayer", top, bot)
    scene = insert_underlayer_images(scene)
    if MARK not in scene:
        if "<!-- ROUND31 body-skin -->" in scene:
            scene = scene.replace("<!-- ROUND31 body-skin -->", "<!-- ROUND31 body-skin -->\n    " + MARK, 1)
        else:
            scene = re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)
    SCENE.write_text(scene, encoding="utf-8")
    update_license(body, arms, top, bot)
    bt = (ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round32_body_base" not in bt:
        (ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round32_body_base.py\n")
    print("ROUND32 body-base done")


if __name__ == "__main__":
    main()
