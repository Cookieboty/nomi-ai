#!/usr/bin/env python3
"""ROUND31b: convert body-backfill into a continuous bare-skin torso/hip underlay,
clean orange coat rim out of shoulder-skin, and add arm-under-skin layers (same
mesh as sleeves, drawn beneath them) so hide-coat no longer severs the arms.

Idempotent via MARK + sha notes in DETAIL_LICENSE / arm-*-under-skin.json.
"""
from __future__ import annotations
import hashlib, json, re, shutil
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
MARK = "<!-- ROUND31 body-skin -->"
MASTER = PROJECT / "source-nomi-master.png"

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


def feather_alpha(rgb_a, solid_dist=2.0):
    m = rgb_a[:, :, 3] > 0
    dist = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
    out = rgb_a.copy()
    out[:, :, 3] = np.where(m, np.where(dist >= solid_dist, 255, np.clip(dist / solid_dist * 255, 0, 255).astype(np.uint8)), 0)
    return out


def build_body_skin():
    """Rewrite body-backfill.png as continuous peach skin over torso+hips."""
    master = np.array(Image.open(MASTER).convert("RGBA"))
    bf0 = np.array(Image.open(SVG / "body-backfill.png").convert("RGBA"))
    h, w = bf0.shape[:2]
    r, g, b, a = [master[:, :, i].astype(np.float32) for i in range(4)]
    sk = skin_mask(master[:, :, :3], master[:, :, 3], 128)
    dark = (a >= 128) & (np.maximum(np.maximum(r, g), b) <= 130)
    yy, xx = np.mgrid[0:h, 0:w]
    torso_box = (xx >= 400) & (xx <= 624) & (yy >= 320) & (yy <= 780)
    cur = bf0[:, :, 3] >= 8
    mask = ((torso_box & (sk | dark | cur)) | cur).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats((mask == 0).astype(np.uint8), 4)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_LEFT] == 0 or stats[i, cv2.CC_STAT_TOP] == 0:
            continue
        if stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] >= w:
            continue
        if stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT] >= h:
            continue
        if stats[i, cv2.CC_STAT_AREA] < 8000:
            mask[lab == i] = 255
    mask = np.maximum(mask, cur.astype(np.uint8) * 255)

    seeds = np.zeros((h, w), bool)
    seeds |= sk & (yy >= 300) & (yy <= 420) & (xx >= 430) & (xx <= 594)
    seeds |= sk & (yy >= 700) & (yy <= 780) & (xx >= 420) & (xx <= 604)
    for side, origin in (("l", (315, 250)), ("r", (554, 250))):
        sh = np.array(Image.open(SVG / f"arm-{side}-shoulder-skin.png").convert("RGBA"))
        x0, y0 = origin
        th, tw = sh.shape[:2]
        y1, x1 = min(h, y0 + th), min(w, x0 + tw)
        region = sh[: y1 - y0, : x1 - x0]
        seeds[y0:y1, x0:x1] |= skin_mask(region[:, :, :3], region[:, :, 3])

    chest = master[:, :, :3][seeds & (yy < 450)].mean(0) if (seeds & (yy < 450)).any() else np.array([248.0, 210.0, 190.0])
    hip = master[:, :, :3][seeds & (yy > 650)].mean(0) if (seeds & (yy > 650)).any() else np.array([240.0, 200.0, 180.0])
    t = np.clip((yy.astype(float) - 320) / 460, 0, 1)
    base = chest[None, None, :] * (1 - t[..., None]) + hip[None, None, :] * t[..., None]
    shade = 1.0 - 0.08 * np.clip(np.abs(xx - 512) / 100.0, 0, 1) ** 2
    base = base * shade[..., None]

    # Seed-propagated fill: start from base, stamp real seeds, blur lightly inside mask
    rgb = base.astype(np.float32)
    rgb[seeds] = master[:, :, :3][seeds].astype(np.float32)
    # blur only within mask to soften seed islands
    blur = cv2.GaussianBlur(rgb, (0, 0), 3)
    rgb = np.where((mask > 0)[..., None], blur, rgb)
    rgb[seeds] = master[:, :, :3][seeds].astype(np.float32)  # keep seeds crisp

    out = np.zeros_like(bf0)
    out[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[:, :, 3] = np.where(mask > 0, 255, 0).astype(np.uint8)
    out = feather_alpha(out, 2.0)
    Image.fromarray(out).save(SVG / "body-backfill.png", optimize=True)
    om = out[:, :, 3] >= 8
    skn = skin_mask(out[:, :, :3], out[:, :, 3])
    dark_n = int((om & (out[:, :, 0] < 90) & (out[:, :, 1] < 90) & (out[:, :, 2] < 90)).sum())
    return dict(opaque=int(om.sum()), skin=int(skn.sum()), dark=dark_n, chest=[round(float(x), 1) for x in chest], hip=[round(float(x), 1) for x in hip])


def clean_shoulder_orange():
    """Remove orange coat rim from shoulder-skin; inpaint skin."""
    stats = {}
    for side in "lr":
        p = SVG / f"arm-{side}-shoulder-skin.png"
        im = np.array(Image.open(p).convert("RGBA"))
        og = orange_mask(im[:, :, :3], im[:, :, 3])
        if not og.any():
            stats[side] = dict(removed=0)
            continue
        # known = opaque non-orange
        known = (im[:, :, 3] >= 8) & ~og
        src = im[:, :, :3].copy()
        # inpaint orange pixels
        fill = cv2.inpaint(cv2.cvtColor(src, cv2.COLOR_RGB2BGR), og.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
        fill = cv2.cvtColor(fill, cv2.COLOR_BGR2RGB)
        im[og, :3] = fill[og]
        # keep alpha; if orange was only rim with weak neighbors, ok
        Image.fromarray(im).save(p, optimize=True)
        stats[side] = dict(removed=int(og.sum()))
    return stats


def build_arm_under(side: str):
    """Skin capsule strictly inside solid sleeve footprint (same 225x440 canvas)."""
    sl = np.array(Image.open(SVG / f"sleeve-{side}-full.png").convert("RGBA"))
    up = np.array(Image.open(SVG / f"arm-{side}-upper-skin.png").convert("RGBA"))
    us = skin_mask(up[:, :, :3], up[:, :, 3], 200)
    mean = up[:, :, :3][us].mean(0) if us.any() else np.array([248.0, 212.0, 195.0])
    solid = sl[:, :, 3] >= 200
    d2 = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    arm_m = (d2 >= 14) & solid
    h, w = solid.shape
    out = np.zeros_like(sl)
    for y in range(h):
        xs = np.where(arm_m[y])[0]
        if len(xs) < 2:
            continue
        cx = (xs[0] + xs[-1]) / 2.0
        half = max((xs[-1] - xs[0]) / 2.0, 1.0)
        for x in xs:
            t = abs(x - cx) / half
            shade = 1.0 - 0.12 * min(t, 1.0) ** 2
            vshade = 1.0 - 0.06 * (y / h)
            out[y, x, :3] = np.clip(mean * shade * vshade, 0, 255)
            out[y, x, 3] = 255
    out = feather_alpha(out, 1.5)
    out[sl[:, :, 3] < 200, 3] = 0  # never stick out past solid sleeve
    dest = SVG / f"arm-{side}-under-skin.png"
    Image.fromarray(out).save(dest, optimize=True)
    meta = dict(side=side, opaque=int((out[:, :, 3] >= 8).sum()), mean=[round(float(x), 1) for x in mean], sha256=sha(dest))
    (SVG / f"arm-{side}-under-skin.json").write_text(json.dumps(meta, indent=2) + "
")
    return meta



def insert_arm_under_images(scene: str) -> str:
    """Clone sleeve mesh onto new arm-under-skin ImageAssets; draw just before sleeve."""
    if MARK in scene:
        return scene
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})

    # Ensure ImageAssets exist
    for side in "lr":
        aname = f"fullbody-arm-{side}-under-skin"
        frel = f"reference/svg-rig/arm-{side}-under-skin.png"
        if f'name="{aname}"' not in scene:
            # insert after sleeve asset
            m = re.search(rf'<ImageAsset name="fullbody-sleeve-{side}-full"[^/]*/>', scene)
            if not m:
                m = re.search(rf'<ImageAsset [^>]*file="reference/svg-rig/sleeve-{side}-full\.png"[^/]*/>', scene)
            aid = R8.nid("asset")
            tag = f'<ImageAsset name="{aname}" file="{frel}" id="{aid}"/>'
            scene = scene[: m.end()] + "\n    " + tag + scene[m.end() :]
            print(f"asset {aname} id={aid}")

    for side in "lr":
        sleeve_name = f"full.sleeve-{side}.full.image"
        under_name = f"full.arm-{side}.under-skin.image"
        if under_name in scene:
            continue
        a, b = R8.find_elem(scene, "Image", sleeve_name)
        block = scene[a:b]
        # asset id for under
        am = re.search(rf'<ImageAsset name="fullbody-arm-{side}-under-skin"[^>]*id="([^"]+)"', scene)
        asset = am.group(1)
        iid = R8.nid("image")
        # copy mesh but rename
        mesh = re.search(r"<Mesh\b.*</Mesh>", block, re.S).group(0)
        # new mesh/skin/tendon/vertex ids and names
        def ren(mxml):
            mxml = re.sub(r'name="[^"]*"', lambda m: f'name="{under_name}.mesh"' if ".mesh" in m.group(0) or m.group(0).endswith('mesh"') else m.group(0), mxml, count=1)
            # simpler: replace sleeve name prefixes
            mxml = mxml.replace(f"full.sleeve-{side}.full.image", under_name)
            mxml = mxml.replace(f"sleeve-{side}.", f"arm-{side}-under.")
            # fresh ids for mesh, skin, every vertex-ish id attribute
            def new_id(mo):
                return f'id="{R8.nid("mesh")}"'
            mxml = re.sub(r'\bid="[^"]+"', new_id, mxml)
            return mxml
        mesh2 = ren(mesh)
        xml = (
            f'<Image name="{under_name}" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
            f'scaleX="1" scaleY="1" id="{iid}">{mesh2}</Image>'
        )
        # insert AFTER sleeve-dark: in this scene later siblings draw behind, so under sits under sleeves
        da, db = R8.find_elem(scene, "Image", f"full.sleeve-{side}.full.dark.image")
        scene = scene[:db] + xml + scene[db:]
        print(f"inserted {under_name} after sleeve-dark (draws behind sleeves)")
    scene = scene.replace("<!-- ROUND30 sleeve-backfill -->", "<!-- ROUND30 sleeve-backfill -->\n    " + MARK, 1)
    if MARK not in scene:
        # fall back: append near top of artboard comment area
        scene = re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)
    return scene


def update_license(body_stats, shoulder_stats, arm_stats):
    lic = json.load(open(LICENSE))
    entries = {
        "body-backfill.png": BASE_NOTE + "; ROUND31: dark garment underlay replaced by continuous bare-skin torso/hip fill (seeded from shoulder/neck/thigh skin + vertical gradient); holes filled",
        "arm-l-shoulder-skin.png": BASE_NOTE + "; ROUND31: orange coat rim removed, skin Telea-inpainted",
        "arm-r-shoulder-skin.png": BASE_NOTE + "; ROUND31: orange coat rim removed, skin Telea-inpainted",
        "arm-l-under-skin.png": BASE_NOTE + "; ROUND31: new arm under-sleeve skin capsule (deterministic shade from upper-skin mean), same canvas as sleeve for mesh reuse",
        "arm-r-under-skin.png": BASE_NOTE + "; ROUND31: new arm under-sleeve skin capsule (deterministic shade from upper-skin mean), same canvas as sleeve for mesh reuse",
    }
    for name, method in entries.items():
        path = SVG / name
        if not path.exists():
            continue
        e = lic["assets"].setdefault("reference/svg-rig/" + name, {})
        e.update(sha256=sha(path), bytes=path.stat().st_size, ai_generated=False, in_scene=True, method=method)
    note = lic.get("note", "")
    if "ROUND31" not in note:
        lic["note"] = (
            note
            + " ROUND31: body-backfill converted to bare-skin torso/hip underlay; shoulder-skin orange rim cleaned; "
            + "arm-l/r-under-skin added under sleeves for coat-hide continuity."
        ).strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    (SVG / "round31-body-skin.json").write_text(
        json.dumps(dict(body=body_stats, shoulder=shoulder_stats, arms=arm_stats), indent=2) + "\n"
    )


def hook_build():
    bt = (ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round31_body_skin" not in bt:
        # after round30 sleeve backfill / before coat rig is fine; after spine so torso mesh exists
        needle = "python3 round30_sleeve_backfill.py\n"
        if needle in bt:
            bt = bt.replace(needle, needle + "python3 round31_body_skin.py\n")
        else:
            bt = bt.rstrip() + "\npython3 round31_body_skin.py\n"
        (ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


def main():
    body = build_body_skin()
    print("body-backfill", body)
    shoulder = clean_shoulder_orange()
    print("shoulder", shoulder)
    arms = {s: build_arm_under(s) for s in "lr"}
    print("arms", {k: v["opaque"] for k, v in arms.items()})
    scene = SCENE.read_text(encoding="utf-8")
    if MARK in scene and "full.arm-l.under-skin.image" in scene:
        print("scene already has arm-under; textures refreshed")
    else:
        scene = insert_arm_under_images(scene)
        SCENE.write_text(scene, encoding="utf-8")
    update_license(body, shoulder, arms)
    hook_build()
    print("ROUND31 body-skin done")


if __name__ == "__main__":
    main()
