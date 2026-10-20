#!/usr/bin/env python3
"""ROUND35b: migrate remaining orange hair ornaments.

* hair-lock-l brand-orange → new hair-ornament-l.png (same canvas + cloned lock-l mesh)
* hair-back-l / hair-back-r brand-orange that is ribbon-like → hair-bow (right) or
  hair-ornament-l (left); large coat-collar blobs → coat-l/r-front instead
* backfill hair underneath (move, not copy)
Idempotent via META + MARK.
"""
from __future__ import annotations
import json, re
import numpy as np
import cv2

import round8_scene as R8
import round13_anim as A
import round35_common as C

MARK = "<!-- ROUND35 hair-ornaments -->"
META = C.SVG / "hair-ornament-split-r35.json"


def ribbon_mask(im: np.ndarray) -> np.ndarray:
    """Brand-orange components that look like thin ornaments (not huge coat panels)."""
    ora = C.orange_components(im, min_area=8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(ora.astype(np.uint8), 8)
    keep = np.zeros_like(ora)
    H, W = ora.shape
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA]
        w, h = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        if area < 8:
            continue
        # coat collar blobs: large and chunky
        if area > 400 and w > 25 and h > 30:
            continue
        keep |= lab == i
    return keep


def coat_blob_mask(im: np.ndarray) -> np.ndarray:
    ora = C.orange_components(im, min_area=20)
    n, lab, st, _ = cv2.connectedComponentsWithStats(ora.astype(np.uint8), 8)
    keep = np.zeros_like(ora)
    for i in range(1, n):
        area = st[i, cv2.CC_STAT_AREA]
        w, h = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        if area > 400 and w > 25 and h > 30:
            keep |= lab == i
        elif area > 200 and max(w, h) > 40:
            keep |= lab == i
    return keep


def split():
    if META.exists():
        meta = json.loads(META.read_text())
        if C.sha(C.SVG / "hair-lock-l.png") == meta.get("lock_l_sha"):
            print("hair ornaments already split", meta)
            return meta

    stats = {}
    lock = C.load("hair-lock-l.png")
    m = C.orange_components(lock, min_area=8)
    # keep all brand orange on lock-l as ornaments (ribbons)
    panel = np.zeros_like(lock)
    panel[m] = lock[m]
    lock2 = C.backfill_hair(lock, m)
    # clear? keep opaque hair from backfill
    C.save("hair-ornament-l.png", panel)
    C.save("hair-lock-l.png", lock2)
    stats["ornament_l_px"] = int(m.sum())
    stats["lock_l_residual_ora"] = int(C.brand_orange(lock2).sum())

    # hair-back: ribbons → ornament/bow; coat blobs → coat
    bow = C.load("hair-bow.png")
    for side, coat_name, to_bow in (("l", "coat-l-front.png", False), ("r", "coat-r-front.png", True)):
        name = f"hair-back-{side}.png"
        im = C.load(name)
        rib = ribbon_mask(im)
        coat = coat_blob_mask(im) & ~rib
        # anything brand-orange left that's not coat → ribbon
        leftover = C.orange_components(im, min_area=8) & ~coat & ~rib
        rib |= leftover
        # move ribbons
        if rib.any():
            if to_bow:
                # paste into bow canvas via mother grid
                tmp = np.zeros_like(im)
                tmp[rib] = im[rib]
                # window into bow
                win = C.window(name, tmp, "hair-bow.png", bow.shape)
                take = win[:, :, 3] >= 8
                # only write where bow empty to avoid duplicating R33 bow
                empty = bow[:, :, 3] < 8
                write = take & empty
                bow[write] = win[write]
                # if overlap with existing bow, still OK (same ornament) — skip duplicate
                stats[f"back_{side}_to_bow"] = int(write.sum())
            else:
                # merge into ornament-l via mother grid
                orn = C.load("hair-ornament-l.png")
                tmp = np.zeros_like(im)
                tmp[rib] = im[rib]
                win = C.window(name, tmp, "hair-lock-l.png", orn.shape)  # same origin as lock-l / ornament-l
                take = win[:, :, 3] >= 8
                empty = orn[:, :, 3] < 8
                write = take & empty
                orn[write] = win[write]
                C.save("hair-ornament-l.png", orn)
                stats[f"back_{side}_to_ornament"] = int(write.sum())
        # move coat blobs
        if coat.any():
            coat_im = C.load(coat_name)
            tmp = np.zeros_like(im)
            tmp[coat] = im[coat]
            n = C.put(coat_name, coat_im, name, tmp, coat)
            C.save(coat_name, coat_im)
            stats[f"back_{side}_to_coat"] = n
        # clear moved pixels from hair-back and backfill hair
        moved = rib | coat
        im2 = im.copy()
        im2[moved] = 0
        # backfill only where we removed opaque hair-adjacent orange (restore hair)
        # for coat blobs that had no hair underneath, leave transparent
        hair_under = moved & (im[:, :, 3] >= 8)
        # re-fill hair color into those texels
        filled = C.backfill_hair(im, hair_under)
        # but for pure coat blobs with little nearby hair, prefer transparency
        a = im[:, :, 3]
        r, g, b = im[:, :, 0].astype(float), im[:, :, 1].astype(float), im[:, :, 2].astype(float)
        lum = (r + g + b) / 3
        near_hair = cv2.dilate(((a >= 8) & ~moved & (lum < 140) & (r < 160)).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        keep_fill = hair_under & near_hair
        clear = hair_under & ~near_hair
        out = im.copy()
        out[keep_fill] = filled[keep_fill]
        out[clear] = 0
        out[rib & ~keep_fill & ~clear] = 0
        out[coat & ~keep_fill] = 0
        # ensure all moved pixels are gone from orange
        out[moved, :] = filled[moved]
        out[clear] = 0
        C.save(name, out)
        stats[f"back_{side}_residual_ora"] = int(C.brand_orange(out).sum())

    C.save("hair-bow.png", bow)
    stats.update(
        lock_l_sha=C.sha(C.SVG / "hair-lock-l.png"),
        ornament_sha=C.sha(C.SVG / "hair-ornament-l.png"),
        bow_sha=C.sha(C.SVG / "hair-bow.png"),
        method="ROUND35b: lock-l + hair-back orange ornaments migrated; coat blobs to coat fronts",
    )
    META.write_text(json.dumps(stats, indent=2) + "\n")
    print("hair ornaments", stats)
    return stats


def insert_ornament_image(scene: str) -> str:
    """Clone hair-lock-l mesh into full.hair.ornament.l.image (same sway)."""
    if "full.hair.ornament.l.image" in scene:
        print("ornament image already present")
        return scene
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3700 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    aname = "fullbody-hair-ornament-l"
    if f'name="{aname}"' not in scene:
        m = re.search(r'<ImageAsset [^>]*file="reference/svg-rig/hair-lock-l\.png"[^/]*/>', scene)
        aid = R8.nid("asset")
        scene = scene[: m.end()] + f'\n    <ImageAsset name="{aname}" file="reference/svg-rig/hair-ornament-l.png" id="{aid}"/>' + scene[m.end() :]
    am = re.search(rf'<ImageAsset name="{aname}"[^>]*id="([^"]+)"', scene)
    asset, iid = am.group(1), R8.nid("image")
    src = "full.hair.lock.l.image"
    a, b = R8.find_elem(scene, "Image", src)
    block = scene[a:b]
    mesh = re.search(r"<Mesh\b.*</Mesh>", block, re.S).group(0)
    dst = "full.hair.ornament.l.image"
    mesh = mesh.replace(src, dst)
    mesh = re.sub(r'\bid="[^"]+"', lambda _m: f'id="{R8.nid("mesh")}"', mesh)
    mesh = mesh.replace(src + ".", dst + ".")
    xml = (
        f'<Image name="{dst}" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
        f'scaleX="1" scaleY="1" id="{iid}">{mesh}</Image>'
    )
    # draw ornament in front of lock-l
    scene = scene[:a] + xml + scene[a:]
    print("inserted", dst)
    return scene


def insert_mark(scene: str) -> str:
    if MARK in scene:
        return scene
    needle = "<!-- ROUND35 choker -->"
    if needle in scene:
        return scene.replace(needle, needle + "\n    " + MARK, 1)
    return re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)


def main():
    # ensure ORIGIN for ornament matches lock-l
    C.ORIGIN["hair-ornament-l.png"] = C.ORIGIN["hair-lock-l.png"]
    meta = split()
    scene = C.SCENE.read_text(encoding="utf-8")
    if MARK not in scene:
        scene = insert_ornament_image(scene)
        scene = insert_mark(scene)
        C.SCENE.write_text(scene, encoding="utf-8")
    C.update_license(
        {
            "hair-lock-l.png": "ROUND35b: orange ornaments moved to hair-ornament-l; hair backfilled",
            "hair-ornament-l.png": "ROUND35b: orange side ornaments from hair-lock-l (+ hair-back-l ribbons); cloned lock-l mesh",
            "hair-back-l.png": "ROUND35b: orange ornaments/coat blobs moved out; hair cleaned",
            "hair-back-r.png": "ROUND35b: orange ornaments moved to hair-bow / coat; hair cleaned",
            "hair-bow.png": "ROUND35b: received hair-back-r ribbon orange (in addition to R33c lock-r bow)",
            "coat-l-front.png": "ROUND35b: received coat-collar blobs moved from hair-back-l",
            "coat-r-front.png": "ROUND35b: received coat-collar blobs moved from hair-back-r",
        },
        "ROUND35b: hair-lock-l/back orange ornaments migrated to ornament-l/bow; coat blobs to coat.",
        "ROUND35b",
    )
    C.hook_build("round35_hair_ornaments.py", "round35_choker.py")
    print("ROUND35b done", meta.get("ornament_l_px"))


if __name__ == "__main__":
    main()
