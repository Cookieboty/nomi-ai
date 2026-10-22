#!/usr/bin/env python3
"""ROUND35c: coat-edge scraps in full.neutral + orange lanyard ring on belt → badge.

* full.neutral (fullbody-base-no-head-arms.png): remove orange/white coat edge remnants;
  move recoverable orange into coat-l/r-front; delete dead duplicates.
* belt-band.png: move the left-side orange lanyard ring (badge hanger) into belt-id.png;
  backfill belt leather underneath.
* shorts-side scrap under badge already noted in R34 — nudge any remaining badge-adjacent
  orange on shorts into shorts-side-orange if still on wrong layer.
Idempotent via META + MARK.
"""
from __future__ import annotations
import json, re
import numpy as np
import cv2

import round35_common as C

MARK = "<!-- ROUND35 coat-badge -->"
META = C.SVG / "coat-badge-clean-r35.json"
NEUTRAL = "fullbody-base-no-head-arms.png"
BAND = "belt-band.png"
ID = "belt-id.png"


def neutral_coat_mask(im: np.ndarray) -> np.ndarray:
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    lum = (r + g + b) / 3
    chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    ora = C.brand_orange(im) | C.loose_orange(im)
    white = (a >= 8) & (lum > 170) & (chroma < 45)
    # only keep components that sit on torso sides (coat edges), not belt center hardware
    m = ora | white
    # drop very center belt buckle leftovers already cleared in R34 if tiny
    H, W = m.shape
    yy, xx = np.mgrid[:H, :W]
    # neutral is full 1024x1536; coat edges roughly x<420 or x>600, y 300-750
    side = ((xx < 430) | (xx > 590)) & (yy > 280) & (yy < 760)
    # also allow mid orange coat flecks
    mid_ora = ora & (yy > 300) & (yy < 720)
    m = (m & side) | mid_ora
    # connected components min area
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    keep = np.zeros_like(m)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= 4:
            keep |= lab == i
    return keep & (a > 0)


def lanyard_ring_mask(band: np.ndarray) -> np.ndarray:
    """Orange U-ring / loop on the LEFT (badge) side of the belt — not orange keepers mid-belt."""
    cm_ora = C.brand_orange(band) | C.loose_orange(band)
    H, W = band.shape[:2]
    yy, xx = np.mgrid[:H, :W]
    # left third of belt, around ring columns (see audit: left orange loop)
    left = (xx >= 5) & (xx <= 55) & (yy >= 5) & (yy <= 42)
    m = cm_ora & left
    # keep connected components that are ring-like (not the far-left vertical strap scrap of coat)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    keep = np.zeros_like(m)
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA]
        x, y, w, h = st[i, 0], st[i, 1], st[i, 2], st[i, 3]
        if area < 8:
            continue
        # ring sits roughly x 20-45
        cx = x + w / 2
        if 15 <= cx <= 50 and area <= 400:
            keep |= lab == i
    # AA fringe
    dil = cv2.dilate(keep.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    a = band[:, :, 3] >= 8
    r, g, b = band[:, :, 0].astype(float), band[:, :, 1].astype(float), band[:, :, 2].astype(float)
    warm = (r > 140) & ((r - b) > 25) & ((r - g) > 10)
    keep |= dil & a & ~keep & warm & left
    return keep


def belt_leather_fill(band: np.ndarray, hole: np.ndarray) -> np.ndarray:
    a = band[:, :, 3]
    r, g, b = band[:, :, 0].astype(float), band[:, :, 1].astype(float), band[:, :, 2].astype(float)
    lum = (r + g + b) / 3
    leather = (a >= 180) & ~hole & (lum < 90) & (r < 100) & ~C.brand_orange(band)
    mean = band[:, :, :3][leather].mean(0) if leather.any() else np.array([45.0, 40.0, 42.0])
    rgb = band[:, :, :3].copy()
    ys, xs = np.where(hole)
    for y, x in zip(ys, xs):
        y0, y1 = max(0, y - 4), min(band.shape[0], y + 5)
        x0, x1 = max(0, x - 4), min(band.shape[1], x + 5)
        patch = leather[y0:y1, x0:x1]
        rgb[y, x] = band[y0:y1, x0:x1][:, :, :3][patch].mean(0) if patch.any() else mean
    mask = hole.astype(np.uint8) * 255
    inp = cv2.inpaint(rgb, mask, 2, cv2.INPAINT_TELEA)
    still = hole & C.brand_orange(np.dstack([inp, band[:, :, 3]]))
    # brand_orange needs alpha — simpler:
    rr, gg, bb = inp[:, :, 0].astype(float), inp[:, :, 1].astype(float), inp[:, :, 2].astype(float)
    still = hole & (rr > 160) & ((rr - bb) > 50)
    inp[still] = mean.astype(np.uint8)
    out = band.copy()
    out[hole, :3] = inp[hole]
    out[hole, 3] = 255
    return out


def split():
    if META.exists():
        meta = json.loads(META.read_text())
        if C.sha(C.SVG / BAND) == meta.get("band_sha") and C.sha(C.SVG / NEUTRAL) == meta.get("neutral_sha"):
            print("coat-badge already cleaned", meta)
            return meta

    stats = {}
    # --- neutral coat scraps ---
    neu = C.load(NEUTRAL)
    nm = neutral_coat_mask(neu)
    # try move orange to coats
    ora = nm & (C.brand_orange(neu) | C.loose_orange(neu))
    white = nm & ~ora
    for coat_name, x_pred in (("coat-l-front.png", lambda xs: xs < 512), ("coat-r-front.png", lambda xs: xs >= 512)):
        ys, xs = np.where(ora)
        if len(ys) == 0:
            continue
        side = x_pred(xs)
        if not side.any():
            continue
        mask = np.zeros_like(ora)
        mask[ys[side], xs[side]] = True
        coat = C.load(coat_name)
        # only write into coat where coat already has coverage nearby OR empty destination that is in coat bbox
        n = C.put(coat_name, coat, NEUTRAL, neu, mask)
        # put always writes — but coat may not cover; count only those that landed
        C.save(coat_name, coat)
        stats[f"neutral_to_{coat_name}"] = n
        ora[mask] = False
    # delete all neutral mask pixels (moved or dead)
    deleted = int(nm.sum())
    neu[nm] = 0
    C.save(NEUTRAL, neu)
    stats["neutral_deleted"] = deleted
    stats["neutral_white_deleted"] = int(white.sum())

    # --- belt lanyard ring → badge ---
    band = C.load(BAND)
    ring = lanyard_ring_mask(band)
    stats["ring_px"] = int(ring.sum())
    if ring.any():
        bid = C.load(ID)
        tmp = np.zeros_like(band)
        tmp[ring] = band[ring]
        n = C.put(ID, bid, BAND, tmp, ring)
        # put into id canvas; if outside, expand? badge ORIGIN (435,509), band (418,473)
        # ring on band left should land near top of id
        C.save(ID, bid)
        stats["ring_to_id"] = n
        band2 = belt_leather_fill(band, ring)
        # clear any residual orange on those pixels already filled
        C.save(BAND, band2)

    # --- orange scrap under badge on shorts → side-orange if still brand-orange in shorts near id ---
    shorts = C.load("shorts.png")
    so = C.load("shorts-side-orange.png")
    win = C.window(ID, C.load(ID), "shorts.png", shorts.shape)
    # region just left of card in shorts — if brand orange still in shorts overlapping id footprint under ring
    ora_s = C.brand_orange(shorts)
    # near id window
    near = cv2.dilate((win[:, :, 3] >= 8).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    scrap = ora_s & near
    if scrap.any():
        n = C.put("shorts-side-orange.png", so, "shorts.png", shorts, scrap)
        shorts[scrap] = 0
        C.save("shorts.png", shorts)
        C.save("shorts-side-orange.png", so)
        stats["shorts_orange_to_side"] = n

    stats.update(
        band_sha=C.sha(C.SVG / BAND),
        id_sha=C.sha(C.SVG / ID),
        neutral_sha=C.sha(C.SVG / NEUTRAL),
        method="ROUND35c: neutral coat scraps cleaned; belt lanyard ring moved to badge",
    )
    META.write_text(json.dumps(stats, indent=2) + "\n")
    print("coat-badge", stats)
    return stats


def insert_mark(scene: str) -> str:
    if MARK in scene:
        return scene
    needle = "<!-- ROUND35 hair-ornaments -->"
    if needle in scene:
        return scene.replace(needle, needle + "\n    " + MARK, 1)
    return re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)


def main():
    meta = split()
    scene = C.SCENE.read_text(encoding="utf-8")
    if MARK not in scene:
        scene = insert_mark(scene)
        C.SCENE.write_text(scene, encoding="utf-8")
    C.update_license(
        {
            NEUTRAL: "ROUND35c: orange/white coat-edge remnants removed (moved to coat or deleted)",
            BAND: "ROUND35c: left orange lanyard ring moved to belt-id; leather backfilled",
            ID: "ROUND35c: received lanyard ring from belt-band",
            "coat-l-front.png": "ROUND35c: received neutral coat-edge orange (left)",
            "coat-r-front.png": "ROUND35c: received neutral coat-edge orange (right)",
            "shorts-side-orange.png": "ROUND35c: received leftover badge-adjacent orange from shorts if any",
            "shorts.png": "ROUND35c: badge-adjacent orange scrap cleared if present",
        },
        "ROUND35c: neutral coat scraps cleaned; belt lanyard ring → badge.",
        "ROUND35c",
    )
    C.hook_build("round35_coat_badge.py", "round35_hair_ornaments.py")
    print("ROUND35c done", meta.get("ring_px"), meta.get("neutral_deleted"))


if __name__ == "__main__":
    main()
