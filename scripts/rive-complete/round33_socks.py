#!/usr/bin/env python3
"""ROUND33a: split white+orange-star socks out of leg-*-skin into sock-{l,r}.png
(same canvas + cloned leg mesh). Backfill bare ankle/shin skin in leg style.

Idempotent via MARK + meta sha.
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
MARK = "<!-- ROUND33 socks -->"
BASE = "deterministic source-pixel rig layer derived from user supplied full-body mother"
META_JSON = SVG / "socks-split-r33.json"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def detect_cuff(im: np.ndarray) -> int:
    h = im.shape[0]
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    lum = (r + g + b) / 3
    chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    peach = (a >= 8) & (r > 180) & (g > 140) & (b > 120) & ((r - b) > 18) & (chroma > 10)
    cool_white = (a >= 8) & (lum > 215) & (chroma < 40) & ((r - b) < 28)
    cuff = 549
    for y in range(530, 575):
        row = a[y] >= 8
        if row.sum() < 10:
            continue
        pw = peach[y].sum() / row.sum()
        cw = cool_white[y].sum() / row.sum()
        if cw > 0.45 and pw < 0.35:
            return y
    return cuff


def sock_mask(im: np.ndarray, cuff: int) -> np.ndarray:
    h, w = im.shape[:2]
    a = im[:, :, 3].astype(np.float32)
    r, g, b = im[:, :, 0].astype(np.float32), im[:, :, 1].astype(np.float32), im[:, :, 2].astype(np.float32)
    lum = (r + g + b) / 3
    chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
    cool_white = (a >= 8) & (lum > 200) & (chroma < 50) & ((r - b) < 40)
    orange = (a >= 8) & (r > 170) & (g > 70) & (g < 190) & (b < 120) & ((r - g) > 35) & ((r - b) > 50)
    dark = (a >= 8) & (lum < 90)
    ys = np.arange(h)[:, None]
    sock = (a >= 8) & (ys >= cuff) & ~dark
    sock |= orange & (ys >= cuff - 6)
    sock |= cool_white & (ys >= cuff - 5) & (ys < cuff)
    # ribbing / white fabric near cuff can be slightly warmer — keep high-lum low-chroma below cuff
    sock |= (a >= 8) & (ys >= cuff) & (lum > 195) & (chroma < 55) & ~dark
    sock = cv2.morphologyEx(sock.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    dil = cv2.dilate(sock.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    fringe = dil & (a >= 1) & ~sock & (ys >= cuff - 6)
    fringe &= cool_white | orange | ((lum > 190) & (chroma < 55) & ((r - b) < 40))
    sock |= fringe
    sock &= ~dark
    return sock


def backfill_leg(im: np.ndarray, sock: np.ndarray, cuff: int) -> np.ndarray:
    """Paint peach shin/ankle skin into sock footprint (keeps alpha silhouette)."""
    h, w = im.shape[:2]
    result = im.copy()
    band = im[max(0, cuff - 55) : max(1, cuff - 3)]
    ba = band[:, :, 3] >= 16
    r, g, b = band[:, :, 0], band[:, :, 1], band[:, :, 2]
    # prefer peach samples (exclude residual sock white)
    peach = ba & (r > 180) & (g > 140) & (b > 110) & ((r.astype(int) - b.astype(int)) > 15)
    if not peach.any():
        peach = ba
    mean = band[:, :, :3][peach].mean(0) if peach.any() else np.array([248.0, 220.0, 205.0])

    col_mean = np.zeros((w, 3), np.float32)
    col_ok = np.zeros(w, bool)
    for x in range(w):
        col = band[:, x]
        m = col[:, 3] >= 16
        rr, gg, bb = col[:, 0], col[:, 1], col[:, 2]
        sk = m & (rr > 180) & (gg > 140) & (bb > 110) & ((rr.astype(int) - bb.astype(int)) > 15)
        if sk.sum() >= 2:
            col_mean[x] = col[sk, :3].mean(0)
            col_ok[x] = True
    for x in range(w):
        if not col_ok[x]:
            near = [nx for nx in range(w) if col_ok[nx]]
            col_mean[x] = col_mean[min(near, key=lambda nx: abs(nx - x))] if near else mean

    rgb = im[:, :, :3].astype(np.float32).copy()
    yy, xx = np.where(sock & (im[:, :, 3] >= 1))
    for y, x in zip(yy, xx):
        t = np.clip((y - cuff) / max(h - cuff, 1), 0, 1)
        # slight AO toward ankle/shoe
        shade = 1.0 - 0.10 * t
        # edge darkening from column occupancy
        rgb[y, x] = np.clip(col_mean[x] * shade, 0, 255)
    blur = cv2.bilateralFilter(rgb.astype(np.uint8), 5, 35, 35)
    out = result.copy()
    out[sock, :3] = blur[sock]
    # keep original alpha in sock region (footprint into shoe)
    return out


def split_textures():
    if META_JSON.exists():
        meta = json.loads(META_JSON.read_text())
        # already split if socks exist and legs have low cool-white below cuff
        ok = True
        for side in ("l", "r"):
            sp = SVG / f"sock-{side}.png"
            lp = SVG / f"leg-{side}-skin.png"
            if not sp.exists() or not lp.exists():
                ok = False
                break
            leg = np.array(Image.open(lp).convert("RGBA"))
            cuff = meta.get(f"cuff_{side}", 549)
            a = leg[:, :, 3]
            r, g, b = leg[:, :, 0].astype(np.float32), leg[:, :, 1].astype(np.float32), leg[:, :, 2].astype(np.float32)
            lum = (r + g + b) / 3
            chroma = np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)
            cool = ((a >= 8) & (np.arange(leg.shape[0])[:, None] >= cuff) & (lum > 220) & (chroma < 30) & ((r - b) < 20)).sum()
            ora = ((a >= 8) & (np.arange(leg.shape[0])[:, None] >= cuff) & (r > 170) & (g < 190) & (b < 120) & ((r - g) > 35)).sum()
            if cool > 400 or ora > 80:
                ok = False
                break
        if ok:
            print("socks already split")
            return meta

    meta = {"method": "ROUND33a: socks moved (not copied) from leg-*-skin into sock-*.png"}
    for side in ("l", "r"):
        lp = SVG / f"leg-{side}-skin.png"
        sp = SVG / f"sock-{side}.png"
        im = np.array(Image.open(lp).convert("RGBA"))
        cuff = detect_cuff(im)
        sock = sock_mask(im, cuff)
        panel = np.zeros_like(im)
        panel[sock] = im[sock]
        filled = backfill_leg(im, sock, cuff)
        Image.fromarray(panel).save(sp, optimize=True)
        Image.fromarray(filled).save(lp, optimize=True)
        meta[f"cuff_{side}"] = cuff
        meta[f"moved_{side}"] = int(sock.sum())
        meta[f"sock_{side}_sha"] = sha(sp)
        meta[f"leg_{side}_sha"] = sha(lp)
        print(f"sock-{side}: moved {meta[f'moved_{side}']} px cuff={cuff}")
    META_JSON.write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def clone_leg_image(scene: str, side: str) -> str:
    src_name = f"full.leg.{side}.skin.image"
    dst_name = f"full.sock.{side}.image"
    if dst_name in scene:
        return scene
    aname = f"fullbody-sock-{side}"
    frel = f"reference/svg-rig/sock-{side}.png"
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    if f'name="{aname}"' not in scene:
        m = re.search(rf'<ImageAsset [^>]*file="reference/svg-rig/leg-{side}-skin\.png"[^/]*/>', scene)
        aid = R8.nid("asset")
        scene = scene[: m.end()] + f'\n    <ImageAsset name="{aname}" file="{frel}" id="{aid}"/>' + scene[m.end() :]
        print("asset", aname, aid)
    a, b = R8.find_elem(scene, "Image", src_name)
    block = scene[a:b]
    am = re.search(rf'<ImageAsset name="{aname}"[^>]*id="([^"]+)"', scene)
    asset, iid = am.group(1), R8.nid("image")
    mesh = re.search(r"<Mesh\b.*</Mesh>", block, re.S).group(0)
    mesh = mesh.replace(src_name, dst_name)
    mesh = re.sub(r'\bid="[^"]+"', lambda _m: f'id="{R8.nid("mesh")}"', mesh)
    # rename nested name attrs that embed src
    mesh = mesh.replace(src_name + ".", dst_name + ".")
    xml = (
        f'<Image name="{dst_name}" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
        f'scaleX="1" scaleY="1" id="{iid}">{mesh}</Image>'
    )
    # early=front: socks over leg skin → insert before leg
    scene = scene[:a] + xml + scene[a:]
    print("inserted", dst_name, "before", src_name)
    return scene


def insert_images(scene: str) -> str:
    if MARK in scene and "full.sock.l.image" in scene and "full.sock.r.image" in scene:
        return scene
    scene = clone_leg_image(scene, "l")
    scene = clone_leg_image(scene, "r")
    if MARK not in scene:
        needle = "<!-- ROUND32 body-base -->"
        if needle in scene:
            scene = scene.replace(needle, needle + "\n    " + MARK, 1)
        else:
            scene = re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)
    return scene


def update_license(meta):
    lic = json.load(open(LICENSE))
    methods = {
        "leg-l-skin.png": BASE + "; ROUND33a: sock pixels moved out into sock-l.png; ankle skin backfilled",
        "leg-r-skin.png": BASE + "; ROUND33a: sock pixels moved out into sock-r.png; ankle skin backfilled",
        "sock-l.png": BASE + "; ROUND33a: white+orange-star sock moved from leg-l-skin (cloned leg mesh)",
        "sock-r.png": BASE + "; ROUND33a: white+orange-star sock moved from leg-r-skin (cloned leg mesh)",
    }
    for name, method in methods.items():
        path = SVG / name
        if not path.exists():
            continue
        e = lic["assets"].setdefault("reference/svg-rig/" + name, {})
        e.update(sha256=sha(path), bytes=path.stat().st_size, ai_generated=False, in_scene=True, method=method)
    if "ROUND33a" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND33a: socks split from leg skins into sock-l/r.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")


def hook_build():
    bt = (ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round33_socks" not in bt:
        needle = "python3 round32_body_base.py\n"
        if needle in bt:
            bt = bt.replace(needle, needle + "python3 round33_socks.py\n")
        else:
            bt = bt.rstrip() + "\npython3 round33_socks.py\n"
        (ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


def main():
    meta = split_textures()
    scene = SCENE.read_text(encoding="utf-8")
    scene2 = insert_images(scene)
    if scene2 != scene:
        SCENE.write_text(scene2, encoding="utf-8")
    update_license(meta)
    hook_build()
    print("ROUND33a socks done", {k: meta[k] for k in meta if k.startswith("moved")})


if __name__ == "__main__":
    main()
