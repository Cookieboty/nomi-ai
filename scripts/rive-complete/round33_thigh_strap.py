#!/usr/bin/env python3
"""ROUND33b: extract black thigh strap+silver buckle (+orange keepers) from
leg-l-skin into thigh-strap.png (cloned leg-l mesh → follows thigh/upper bone).
Backfill thigh skin beneath.

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
MARK = "<!-- ROUND33 thigh-strap -->"
BASE = "deterministic source-pixel rig layer derived from user supplied full-body mother"
META_JSON = SVG / "thigh-strap-split-r33.json"
Y0, Y1 = 92, 138  # strap band on leg-l canvas


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def strap_mask(im: np.ndarray) -> np.ndarray:
    h, w = im.shape[:2]
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    lum = (r + g + b) / 3
    chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    ys = np.arange(h)[:, None]
    band = (ys >= Y0) & (ys <= Y1)
    dark = (a >= 8) & (lum < 105) & (r < 125)
    leather = (a >= 8) & band & (lum < 145) & (r < 155) & (g < 125) & (b < 115) & (chroma < 55)
    silver = (a >= 8) & (lum > 125) & (chroma < 50) & (b >= r - 15) & (g > 95)
    orange = (a >= 8) & (r > 155) & (g > 55) & (g < 200) & (b < 135) & ((r - g) > 28) & ((r - b) > 35)
    seed = (dark | leather) & band
    dil = cv2.dilate(seed.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    strap = seed | (silver & dil) | (orange & dil & band)
    strap |= leather & (cv2.dilate(strap.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
    # soft AO fringe under/over strap (dark peach) — leave on leg for realism; only take accessory
    strap = cv2.morphologyEx(strap.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    n, lab, st, _ = cv2.connectedComponentsWithStats(strap.astype(np.uint8), 8)
    keep = np.zeros_like(strap)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= 40:
            keep |= lab == i
    # AA fringe of dark/silver near keep
    dil2 = cv2.dilate(keep.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    fringe = dil2 & (a >= 1) & ~keep & band
    fringe &= dark | leather | silver | orange | ((lum < 160) & (chroma < 40))
    keep |= fringe
    return keep


def backfill_thigh(im: np.ndarray, strap: np.ndarray) -> np.ndarray:
    h, w = im.shape[:2]
    above = im[max(0, Y0 - 28) : Y0]
    below = im[Y1 + 1 : min(h, Y1 + 30)]
    samples = []
    for part in (above, below):
        m = part[:, :, 3] >= 16
        rr, gg, bb = part[:, :, 0], part[:, :, 1], part[:, :, 2]
        sk = m & (rr > 180) & (gg > 140) & (bb > 120) & ((rr.astype(int) - bb.astype(int)) > 15)
        if sk.any():
            samples.append(part[:, :, :3][sk])
    mean = np.concatenate(samples, 0).mean(0) if samples else np.array([252.0, 226.0, 213.0])

    col_mean = np.zeros((w, 3), np.float32)
    col_ok = np.zeros(w, bool)
    for x in range(w):
        vals = []
        for part in (above, below):
            col = part[:, x]
            m = col[:, 3] >= 16
            rr, gg, bb = col[:, 0], col[:, 1], col[:, 2]
            sk = m & (rr > 180) & (gg > 140) & (bb > 120) & ((rr.astype(int) - bb.astype(int)) > 15)
            if sk.any():
                vals.append(col[sk, :3])
        if vals:
            col_mean[x] = np.concatenate(vals, 0).mean(0)
            col_ok[x] = True
    for x in range(w):
        if not col_ok[x]:
            near = [nx for nx in range(w) if col_ok[nx]]
            col_mean[x] = col_mean[min(near, key=lambda nx: abs(nx - x))] if near else mean

    rgb = im[:, :, :3].astype(np.float32).copy()
    yy, xx = np.where(strap & (im[:, :, 3] >= 1))
    mid = (Y0 + Y1) / 2.0
    for y, x in zip(yy, xx):
        # very slight center highlight continuity
        rgb[y, x] = col_mean[x]
    blur = cv2.bilateralFilter(rgb.astype(np.uint8), 5, 28, 28)
    out = im.copy()
    out[strap, :3] = blur[strap]
    return out


def split_texture():
    lp = SVG / "leg-l-skin.png"
    tp = SVG / "thigh-strap.png"
    if META_JSON.exists() and tp.exists():
        meta = json.loads(META_JSON.read_text())
        leg = np.array(Image.open(lp).convert("RGBA"))
        a = leg[:, :, 3]
        r, g, b = leg[:, :, 0].astype(np.float32), leg[:, :, 1].astype(np.float32), leg[:, :, 2].astype(np.float32)
        lum = (r + g + b) / 3
        ys = np.arange(leg.shape[0])[:, None]
        dark_band = ((a >= 8) & (ys >= Y0) & (ys <= Y1) & (lum < 100)).sum()
        if dark_band < 200:
            print("thigh strap already split", "residual dark", int(dark_band))
            return meta

    im = np.array(Image.open(lp).convert("RGBA"))
    strap = strap_mask(im)
    panel = np.zeros_like(im)
    panel[strap] = im[strap]
    filled = backfill_thigh(im, strap)
    Image.fromarray(panel).save(tp, optimize=True)
    Image.fromarray(filled).save(lp, optimize=True)
    meta = dict(
        moved=int(strap.sum()),
        y0=Y0,
        y1=Y1,
        strap_sha=sha(tp),
        leg_l_sha=sha(lp),
        method="ROUND33b: thigh strap+buckle+keepers moved from leg-l-skin into thigh-strap.png",
    )
    META_JSON.write_text(json.dumps(meta, indent=2) + "\n")
    print("thigh-strap moved", meta["moved"])
    return meta


def insert_image(scene: str) -> str:
    if MARK in scene and "full.thigh-strap.image" in scene:
        return scene
    src_name = "full.leg.l.skin.image"
    dst_name = "full.thigh-strap.image"
    aname = "fullbody-thigh-strap"
    frel = "reference/svg-rig/thigh-strap.png"
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3200 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    if f'name="{aname}"' not in scene:
        m = re.search(r'<ImageAsset [^>]*file="reference/svg-rig/leg-l-skin\.png"[^/]*/>', scene)
        aid = R8.nid("asset")
        scene = scene[: m.end()] + f'\n    <ImageAsset name="{aname}" file="{frel}" id="{aid}"/>' + scene[m.end() :]
        print("asset", aname, aid)
    if dst_name not in scene:
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
        # early=front: strap over leg
        scene = scene[:a] + xml + scene[a:]
        print("inserted", dst_name)
    if MARK not in scene:
        needle = "<!-- ROUND33 socks -->"
        if needle in scene:
            scene = scene.replace(needle, needle + "\n    " + MARK, 1)
        else:
            scene = re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)
    return scene


def update_license(meta):
    lic = json.load(open(LICENSE))
    for name, method in {
        "leg-l-skin.png": BASE + "; ROUND33b: thigh strap moved out into thigh-strap.png; thigh skin backfilled",
        "thigh-strap.png": BASE + "; ROUND33b: black strap+silver buckle+orange keepers from leg-l-skin (cloned leg-l mesh)",
    }.items():
        path = SVG / name
        if not path.exists():
            continue
        e = lic["assets"].setdefault("reference/svg-rig/" + name, {})
        e.update(sha256=sha(path), bytes=path.stat().st_size, ai_generated=False, in_scene=True, method=method)
    if "ROUND33b" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND33b: thigh strap split from leg-l-skin.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")


def hook_build():
    bt = (ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round33_thigh_strap" not in bt:
        needle = "python3 round33_socks.py\n"
        if needle in bt:
            bt = bt.replace(needle, needle + "python3 round33_thigh_strap.py\n")
        else:
            bt = bt.rstrip() + "\npython3 round33_thigh_strap.py\n"
        (ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


def main():
    meta = split_texture()
    scene = SCENE.read_text(encoding="utf-8")
    scene2 = insert_image(scene)
    if scene2 != scene:
        SCENE.write_text(scene2, encoding="utf-8")
    update_license(meta)
    hook_build()
    print("ROUND33b thigh-strap done", meta.get("moved"))


if __name__ == "__main__":
    main()
