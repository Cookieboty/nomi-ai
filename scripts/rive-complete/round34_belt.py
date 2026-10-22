#!/usr/bin/env python3
"""ROUND34a: belt-band.png was a rectangular crop: leather belt + buckles/keepers AND the tank/shorts fabric,
coat-lapel orange and lanyard/pouch-strap stubs around it.  Hiding the belt exposed a skin-coloured bar.

* belt-band.png keeps only the belt (leather band polygon + silver buckles + orange keepers on the band).
* Every other pixel of the crop MOVES to new waist-backfill.png (same canvas/mesh as the band, shorts group),
  except lanyard / pouch-strap stubs below the band that are exact duplicates of belt-id / belt-pouch (dropped).
* Under the belt polygon waist-backfill gets inpainted shorts-waistband fabric (Telea+NS from tank above / shorts
  below + thread grain + faint waist seam), so a hidden belt reveals garment, not skin.
* full.neutral (edge-scrap layer, always visible at the very back) loses its belt-buckle scraps inside the belt
  polygon (duplicates hidden behind band+backfill).
* Scene: full.shorts.waist-backfill.image = clone of full.belt.band.image mesh (torso->pelvis skin), drawn behind
  the badge/pouch and in front of shorts.
Idempotent: meta json stores the post-split band sha."""
from __future__ import annotations
import json, re
import numpy as np
import cv2
import round8_scene as R8
import round13_anim as A
import round34_common as C

MARK = "<!-- ROUND34 belt -->"
META = C.SVG / "belt-split-r34.json"
BAND, FILL = "belt-band.png", "waist-backfill.png"
NEUTRAL = "fullbody-base-no-head-arms.png"


def belt_polygon(shape):
    H, W = shape[:2]
    yy, xx = np.mgrid[:H, :W]
    top = 10.5 - 1.0 * (xx / W)
    bot = 39.5 - 2.0 * (xx / W)
    return (yy >= top) & (yy <= bot) & (xx >= 7) & (xx <= 163)


def belt_mask(band):
    cm = C.colour_masks(band)
    poly = belt_polygon(band.shape)
    H, W = poly.shape
    yy = np.mgrid[:H, :W][0]
    near = cv2.dilate(poly.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    rows = (yy >= 6) & (yy <= 41)
    extra = near & rows & (cm["silver"] | cm["orange"])
    m = poly | extra
    # AA rim: 1px ring of dark/silver pixels hugging the band
    ring = (cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & ~m & rows
    m |= ring & (cm["silver"] | (cm["lum"] < 30))
    return m & (cm["a"] > 0)


def split():
    band = C.load(BAND)
    if META.exists() and (C.SVG / FILL).exists():
        meta = json.loads(META.read_text())
        if C.sha(C.SVG / BAND) == meta.get("band_sha"):
            print("belt already split")
            return meta
    m = belt_mask(band)
    rest = band.copy(); rest[m] = 0
    # duplicates: orange/silver stubs under the band that belt-id / belt-pouch already carry
    dup = np.zeros(m.shape, bool)
    for acc in ("belt-id.png", "belt-pouch.png"):
        win = C.window(acc, C.load(acc), BAND, band.shape)
        cm = C.colour_masks(rest)
        dup |= (win[:, :, 3] >= 200) & (rest[:, :, 3] > 0) & (cm["orange"] | cm["silver"]) & ~belt_polygon(band.shape)
    rest[dup] = 0
    # context for inpaint: band remainder over tank (above) over shorts (below)
    ctx = np.zeros_like(band)
    for nm in ("torso-tank.png", "shorts.png"):
        w = C.window(nm, C.load(nm), BAND, band.shape)
        o = w[:, :, 3] >= 200
        ctx[o] = w[o]
    o = rest[:, :, 3] >= 200
    ctx[o] = rest[o]
    hole = cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    ctx[hole] = 0
    cc = C.colour_masks(ctx)
    ctx[cc["orange"] | cc["silver"] | (cc["chroma"] > 45)] = 0   # fabric-only context (no keeper/coat orange bleed)
    filled = C.fabric_fill(ctx, hole, seed=341, grain=1.0, blur=1.6)
    out = rest.copy()
    out[hole] = filled[hole]
    # faint waistband seam across the fill (shorts top-stitch), ~belt centre line
    H, W = m.shape
    for x in range(W):
        col = np.nonzero(hole[:, x])[0]
        if len(col) < 8:
            continue
        yc = int(round((col[0] + col[-1]) / 2)) + 4
        out[yc, x, :3] = np.clip(out[yc, x, :3].astype(int) - 9, 0, 255)
        out[yc + 1, x, :3] = np.clip(out[yc + 1, x, :3].astype(int) + 6, 0, 255)
    beltonly = np.zeros_like(band); beltonly[m] = band[m]
    # neutral scraps inside the belt polygon (world-aligned in the mother grid)
    neu = C.load(NEUTRAL)
    ox, oy = C.ORIGIN[BAND]
    sub = neu[oy : oy + H, ox : ox + W]
    kill = hole & (sub[:, :, 3] > 0)
    sub[kill] = 0
    neu[oy : oy + H, ox : ox + W] = sub
    C.save(BAND, beltonly); C.save(FILL, out); C.save(NEUTRAL, neu)
    meta = dict(belt_px=int(m.sum()), moved_to_backfill=int((rest[:, :, 3] > 0).sum()), dup_dropped=int(dup.sum()),
                inpainted=int(hole.sum()), neutral_scraps_removed=int(kill.sum()),
                band_sha=C.sha(C.SVG / BAND), fill_sha=C.sha(C.SVG / FILL),
                method="ROUND34a belt-only band; fabric remainder + inpainted waistband -> waist-backfill.png")
    META.write_text(json.dumps(meta, indent=2) + "\n")
    print("belt split", meta)
    return meta


def scene_edit(scene: str) -> str:
    if MARK in scene and "full.shorts.waist-backfill.image" in scene:
        return scene
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3200 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    aname = "fullbody-waist-backfill"
    if f'name="{aname}"' not in scene:
        scene = C.asset_after(scene, BAND, aname, "reference/svg-rig/" + FILL, R8.nid("asset"))
    dst = "full.shorts.waist-backfill.image"
    if dst not in scene:
        a, b = R8.find_elem(scene, "Image", "full.belt.band.image")
        mesh = re.search(r"<Mesh\b.*</Mesh>", scene[a:b], re.S).group(0)
        mesh = re.sub(r'\bid="[^"]+"', lambda _m: f'id="{R8.nid("mesh")}"', mesh)
        mesh = mesh.replace("full.belt.band.image", dst)
        aid = re.search(rf'<ImageAsset name="{aname}"[^>]*id="([^"]+)"', scene).group(1)
        xml = (f'<Image name="{dst}" assetId="{aid}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" '
               f'id="{R8.nid("image")}">{mesh}</Image>\n')
        i = scene.index('<Image name="full.shorts.side-orange.image"')
        scene = scene[:i] + xml + scene[i:]
        print("inserted", dst)
    if MARK not in scene:
        needle = "<!-- ROUND33 thigh-strap -->"
        scene = scene.replace(needle, needle + "\n    " + MARK, 1) if needle in scene else \
            re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)
    return scene


def main():
    meta = split()
    s = C.SCENE.read_text(encoding="utf-8")
    s2 = scene_edit(s)
    if s2 != s:
        C.SCENE.write_text(s2, encoding="utf-8")
    C.update_license({
        BAND: "ROUND34a: belt only (leather band + buckles + keepers); surrounding fabric moved to waist-backfill.png",
        FILL: "ROUND34a: non-belt pixels of the old belt crop + Telea/NS inpainted waistband fabric under the belt (procedural, not hand-painted)",
        NEUTRAL: "ROUND34a: belt-buckle scraps under the band removed (duplicates)",
    }, "ROUND34a: belt split from fabric; waist-backfill under belt.", "ROUND34a")
    C.hook_build("round34_belt.py", "round33_hair_bow.py")
    print("ROUND34a belt done")


if __name__ == "__main__":
    main()
