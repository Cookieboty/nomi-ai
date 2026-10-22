#!/usr/bin/env python3
"""ROUND33c: extract orange hair-bow ribbon from hair-lock-r into hair-bow.png
(same canvas as lock-r + cloned lock-r mesh → inherits R20 lock sway).
Backfill dark hair in lock-r; retire the near-empty rigid bow Image under
full.hair.bow bone.

Idempotent via MARK + meta.
"""
from __future__ import annotations
import hashlib, json, re
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
SVG = PROJECT / "reference/svg-rig"
LICENSE = PROJECT / "parts/DETAIL_LICENSE.json"
MARK = "<!-- ROUND33 hair-bow -->"
BASE = "deterministic source-pixel rig layer derived from user supplied full-body mother"
META_JSON = SVG / "hair-bow-split-r33.json"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def orange_mask(im: np.ndarray) -> np.ndarray:
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    orange = (a >= 8) & (r > 155) & (g > 45) & (g < 205) & (b < 140) & ((r - g) > 28) & ((r - b) > 35)
    # keep ribbon-like components (drop tiny noise)
    n, lab, st, _ = cv2.connectedComponentsWithStats(orange.astype(np.uint8), 8)
    keep = np.zeros_like(orange)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= 12:
            keep |= lab == i
    # AA fringe
    dil = cv2.dilate(keep.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    fringe = dil & (a >= 1) & ~keep
    warm = (r > 140) & ((r - b) > 25) & ((r - g) > 15) & (g < 210)
    keep |= fringe & warm
    return keep


def backfill_hair(im: np.ndarray, bow: np.ndarray) -> np.ndarray:
    """Fill bow holes with dark-brown hair sampled from neighbors (no Telea orange bleed)."""
    h, w = im.shape[:2]
    a = im[:, :, 3]
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    lum = (r + g + b) / 3
    # dark/mid hair (exclude orange + skin)
    hair = (a >= 8) & ~bow & (lum < 140) & (r < 160) & (b < 120)
    if not hair.any():
        hair = (a >= 8) & ~bow & (lum < 180)
    mean = im[:, :, :3][hair].mean(0) if hair.any() else np.array([55.0, 35.0, 30.0])

    # seed: replace bow RGB with mean hair, then inpaint
    rgb = im[:, :, :3].copy()
    rgb[bow] = mean.astype(np.uint8)
    # also pull nearby hair colors via distance-weighted average
    yy, xx = np.where(bow)
    for y, x in zip(yy, xx):
        y0, y1 = max(0, y - 6), min(h, y + 7)
        x0, x1 = max(0, x - 6), min(w, x + 7)
        patch_h = hair[y0:y1, x0:x1]
        if patch_h.any():
            rgb[y, x] = im[y0:y1, x0:x1][:, :, :3][patch_h].mean(0)
        else:
            rgb[y, x] = mean
    mask = bow.astype(np.uint8) * 255
    # light Telea only as soften — border already hair-colored
    inp = cv2.inpaint(rgb, mask, 3, cv2.INPAINT_TELEA)
    # force non-orange
    rr, gg, bb = inp[:, :, 0].astype(np.float32), inp[:, :, 1].astype(np.float32), inp[:, :, 2].astype(np.float32)
    still_ora = bow & (rr > 150) & ((rr - gg) > 25) & ((rr - bb) > 30)
    inp[still_ora] = mean.astype(np.uint8)
    blur = cv2.bilateralFilter(inp, 5, 40, 40)
    out = im.copy()
    out[bow, :3] = blur[bow]
    # keep alpha: bow region stays opaque where lock had coverage
    return out


def split_texture():
    lp = SVG / "hair-lock-r.png"
    bp = SVG / "hair-bow.png"
    if META_JSON.exists() and bp.exists():
        meta = json.loads(META_JSON.read_text())
        lock = np.array(Image.open(lp).convert("RGBA"))
        a = lock[:, :, 3]
        r, g, b = lock[:, :, 0].astype(np.float32), lock[:, :, 1].astype(np.float32), lock[:, :, 2].astype(np.float32)
        ora = int(((a >= 8) & (r > 160) & (g < 200) & (b < 130) & ((r - g) > 30) & ((r - b) > 40)).sum())
        bow = np.array(Image.open(bp).convert("RGBA"))
        # done if lock low-orange and bow has content matching lock canvas size
        if ora < 200 and bow.shape[:2] == lock.shape[:2] and (bow[:, :, 3] >= 8).sum() > 500:
            print("hair-bow already split, residual orange", ora)
            return meta

    im = np.array(Image.open(lp).convert("RGBA"))
    bow = orange_mask(im)
    panel = np.zeros_like(im)
    panel[bow] = im[bow]
    filled = backfill_hair(im, bow)
    Image.fromarray(panel).save(bp, optimize=True)
    Image.fromarray(filled).save(lp, optimize=True)
    meta = dict(
        moved=int(bow.sum()),
        bow_sha=sha(bp),
        lock_r_sha=sha(lp),
        bow_shape=list(panel.shape[:2]),
        method="ROUND33c: orange bow ribbon moved from hair-lock-r into hair-bow.png (cloned lock-r mesh)",
    )
    META_JSON.write_text(json.dumps(meta, indent=2) + "\n")
    print("hair-bow moved", meta["moved"], "shape", meta["bow_shape"])
    return meta


def retire_empty_bow_image(scene: str) -> str:
    """Remove rigid empty bow Image nested under full.hair.bow bone (keep bone for hierarchy)."""
    # Match self-closing or empty Image full.hair.bow.image without Mesh
    pat = re.compile(
        r'<Image name="full\.hair\.bow\.image"[^>]*?(?:/>|>\s*</Image>)',
        re.S,
    )
    m = pat.search(scene)
    if not m:
        return scene
    block = m.group(0)
    if "<Mesh" in block:
        # already skinned version — leave
        return scene
    scene = scene[: m.start()] + scene[m.end() :]
    print("removed empty rigid full.hair.bow.image")
    return scene


def insert_skinned_bow(scene: str) -> str:
    src_name = "full.hair.lock.r.image"
    dst_name = "full.hair.bow.image"
    aname = "fullbody-hair-bow"
    # Asset already exists pointing at hair-bow.png — keep it
    if f'name="{dst_name}"' in scene and "<Mesh" in scene[scene.find(f'name="{dst_name}"') : scene.find(f'name="{dst_name}"') + 500]:
        # crude: if mesh nearby, done
        a0 = scene.find(f'<Image name="{dst_name}"')
        a1 = scene.find("</Image>", a0) if a0 >= 0 else -1
        if a0 >= 0 and a1 > a0 and "<Mesh" in scene[a0:a1]:
            print("skinned bow image already present")
            return scene

    scene = retire_empty_bow_image(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3400 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})

    # ensure asset
    if f'name="{aname}"' not in scene:
        m = re.search(r'<ImageAsset [^>]*file="reference/svg-rig/hair-lock-r\.png"[^/]*/>', scene)
        aid = R8.nid("asset")
        scene = scene[: m.end()] + f'\n    <ImageAsset name="{aname}" file="reference/svg-rig/hair-bow.png" id="{aid}"/>' + scene[m.end() :]
        print("asset", aname, aid)

    a, b = R8.find_elem(scene, "Image", src_name)
    block = scene[a:b]
    am = re.search(rf'<ImageAsset name="{aname}"[^>]*id="([^"]+)"', scene)
    asset, iid = am.group(1), R8.nid("image")
    mesh = re.search(r"<Mesh\b.*</Mesh>", block, re.S).group(0)
    mesh = mesh.replace(src_name, dst_name)
    mesh = re.sub(r'\bid="[^"]+"', lambda _m: f'id="{R8.nid("mesh")}"', mesh)
    mesh = mesh.replace(src_name + ".", dst_name + ".")
    xml = (
        f'<Image name="{dst_name}" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
        f'scaleX="1" scaleY="1" id="{iid}">{mesh}</Image>'
    )
    # early=front: bow over lock hair
    scene = scene[:a] + xml + scene[a:]
    print("inserted skinned", dst_name, "before", src_name)
    return scene


def insert_mark(scene: str) -> str:
    if MARK in scene:
        return scene
    needle = "<!-- ROUND33 thigh-strap -->"
    if needle in scene:
        return scene.replace(needle, needle + "\n    " + MARK, 1)
    return re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)


def update_license(meta):
    lic = json.load(open(LICENSE))
    for name, method in {
        "hair-lock-r.png": BASE + "; ROUND33c: orange bow ribbon moved out into hair-bow.png; hair backfilled",
        "hair-bow.png": BASE + "; ROUND33c: orange bow from hair-lock-r (same canvas, cloned lock-r mesh for R20 sway)",
    }.items():
        path = SVG / name
        if not path.exists():
            continue
        e = lic["assets"].setdefault("reference/svg-rig/" + name, {})
        e.update(sha256=sha(path), bytes=path.stat().st_size, ai_generated=False, in_scene=True, method=method)
    if "ROUND33c" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND33c: hair-bow extracted from hair-lock-r.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")


def hook_build():
    bt = (ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round33_hair_bow" not in bt:
        needle = "python3 round33_thigh_strap.py\n"
        if needle in bt:
            bt = bt.replace(needle, needle + "python3 round33_hair_bow.py\n")
        else:
            bt = bt.rstrip() + "\npython3 round33_hair_bow.py\n"
        (ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


def main():
    meta = split_texture()
    scene = SCENE.read_text(encoding="utf-8")
    scene2 = insert_skinned_bow(scene)
    scene2 = insert_mark(scene2)
    if scene2 != scene:
        SCENE.write_text(scene2, encoding="utf-8")
    update_license(meta)
    hook_build()
    print("ROUND33c hair-bow done", meta.get("moved"))


if __name__ == "__main__":
    main()
