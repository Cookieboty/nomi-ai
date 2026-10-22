#!/usr/bin/env python3
"""ROUND31c: move orange side accents out of shorts.png into shorts-side-orange.png
(same canvas + cloned shorts mesh), so they are a distinct hideable garment layer
and no longer ambiguously fused into the body/shorts silhouette.

Idempotent via MARK.
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
MARK = "<!-- ROUND31 shorts-orange -->"
BASE = "deterministic source-pixel rig layer derived from user supplied full-body mother"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def orange_keep(sh):
    r, g, b, a = sh[:, :, 0].astype(np.float32), sh[:, :, 1].astype(np.float32), sh[:, :, 2].astype(np.float32), sh[:, :, 3]
    orange = (a >= 8) & (r > 160) & (g > 60) & (g < 200) & (b < 120) & ((r - g) > 35) & ((r - b) > 50)
    og = cv2.dilate(orange.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    og &= a >= 8
    n, lab, stats, _ = cv2.connectedComponentsWithStats(og.astype(np.uint8), 8)
    keep = np.zeros_like(og)
    for i in range(1, n):
        comp = lab == i
        frac = float(((r > 180) & (g > 80) & (g < 180) & (b < 100) & ((r - g) > 40))[comp].mean()) if comp.any() else 0
        if frac > 0.25 and stats[i, cv2.CC_STAT_AREA] > 30:
            keep |= comp
    return keep


def split_texture():
    sp = SVG / "shorts.png"
    op = SVG / "shorts-side-orange.png"
    sj = SVG / "shorts-side-orange.json"
    sh = np.array(Image.open(sp).convert("RGBA"))
    if op.exists() and sj.exists() and json.loads(sj.read_text()).get("shorts_sha") == sha(sp):
        print("shorts orange already split")
        return json.loads(sj.read_text())
    # If re-running after split, shorts_sha won't match committed shorts — rebuild from backup? 
    # Prefer: if orange file exists and shorts has low orange, skip.
    r, g, b, a = sh[:, :, 0].astype(np.float32), sh[:, :, 1].astype(np.float32), sh[:, :, 2].astype(np.float32), sh[:, :, 3]
    strict = int(((a >= 8) & (r > 180) & (g > 80) & (g < 180) & (b < 100) & ((r - g) > 40)).sum())
    if strict < 200 and op.exists():
        print("shorts already low-orange; keeping", strict)
        return json.loads(sj.read_text()) if sj.exists() else {}

    keep = orange_keep(sh)
    panel = np.zeros_like(sh)
    panel[keep] = sh[keep]
    # clear from shorts (keep RGB under transparent for filter fringe)
    sh2 = sh.copy()
    sh2[keep, 3] = 0
    Image.fromarray(panel).save(op, optimize=True)
    Image.fromarray(sh2).save(sp, optimize=True)
    meta = dict(
        moved=int(keep.sum()),
        shorts_sha=sha(sp),
        orange_sha=sha(op),
        method="ROUND31c: orange side accents moved (not copied) from shorts.png into shorts-side-orange.png",
    )
    sj.write_text(json.dumps(meta, indent=2) + "\n")
    print("moved", meta["moved"], "orange px")
    return meta


def insert_image(scene: str) -> str:
    if MARK in scene and "full.shorts.side-orange.image" in scene:
        return scene
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    aname = "fullbody-shorts-side-orange"
    frel = "reference/svg-rig/shorts-side-orange.png"
    if f'name="{aname}"' not in scene:
        m = re.search(r'<ImageAsset [^>]*file="reference/svg-rig/shorts\.png"[^/]*/>', scene)
        aid = R8.nid("asset")
        scene = scene[: m.end()] + f'\n    <ImageAsset name="{aname}" file="{frel}" id="{aid}"/>' + scene[m.end() :]
        print("asset", aname, aid)
    if "full.shorts.side-orange.image" not in scene:
        a, b = R8.find_elem(scene, "Image", "full.shorts.image")
        block = scene[a:b]
        am = re.search(rf'<ImageAsset name="{aname}"[^>]*id="([^"]+)"', scene)
        asset, iid = am.group(1), R8.nid("image")
        mesh = re.search(r"<Mesh\b.*</Mesh>", block, re.S).group(0)
        mesh = mesh.replace("full.shorts.image", "full.shorts.side-orange.image")
        mesh = re.sub(r'\bid="[^"]+"', lambda _m: f'id="{R8.nid("mesh")}"', mesh)
        xml = (
            f'<Image name="full.shorts.side-orange.image" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
            f'scaleX="1" scaleY="1" id="{iid}">{mesh}</Image>'
        )
        # early=front: orange accents on top of shorts fabric → insert before shorts
        scene = scene[:a] + xml + scene[a:]
        print("inserted shorts.side-orange before shorts")
    if MARK not in scene:
        scene = scene.replace("<!-- ROUND31 body-skin -->", "<!-- ROUND31 body-skin -->\n    " + MARK, 1)
        if MARK not in scene:
            scene = re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)
    return scene


def update_license(meta):
    lic = json.load(open(LICENSE))
    for name, method in {
        "shorts.png": BASE + "; ROUND31c: orange side accents moved out into shorts-side-orange.png",
        "shorts-side-orange.png": BASE + "; ROUND31c: orange side accents moved from shorts.png (same canvas, cloned shorts mesh)",
    }.items():
        path = SVG / name
        if not path.exists():
            continue
        e = lic["assets"].setdefault("reference/svg-rig/" + name, {})
        e.update(sha256=sha(path), bytes=path.stat().st_size, ai_generated=False, in_scene=True, method=method)
    if "ROUND31c" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND31c: shorts side orange accents split into shorts-side-orange.png.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")


def hook_build():
    bt = (ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round31_shorts_orange" not in bt:
        needle = "python3 round31_body_skin.py\n"
        if needle in bt:
            bt = bt.replace(needle, needle + "python3 round31_shorts_orange.py\n")
        else:
            bt = bt.rstrip() + "\npython3 round31_shorts_orange.py\n"
        (ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


def main():
    meta = split_texture()
    scene = SCENE.read_text(encoding="utf-8")
    scene2 = insert_image(scene)
    if scene2 != scene:
        SCENE.write_text(scene2, encoding="utf-8")
    update_license(meta)
    hook_build()
    print("ROUND31c shorts-orange done", meta.get("moved"))


if __name__ == "__main__":
    main()
