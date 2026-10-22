#!/usr/bin/env python3
"""ROUND34c: ID badge + lanyard.  belt-id.png was a 54x162 rectangle: lanyard, rings, clip, white 'N' card AND the
shorts fabric (plus a stray orange strap scrap) around them, rigid on RootBone full.belt.id (pelvis child) with lag
keys in idle/walk/run.

* belt-id.png keeps only lanyard strap + silver rings + black clip + card (border, 'N', dots).
* Non-badge pixels MOVE: orange -> shorts-side-orange.png, rest -> shorts.png; the area under the badge in
  shorts.png is refilled (normalized-conv mean of surrounding dark fabric + faint folds; procedural).
* full.belt.id.image becomes a skinned grid mesh: lanyard top (y<=440, inside/under the belt) on pelvis, blending to
  the badge bone by y=452 -> the lanyard bends instead of the whole tag pivoting rigidly; card on bone.
  Existing idle/walk/run bone keys are untouched; hop/squat/step get damped-pendulum lag + small bounce keys.
Idempotent (meta sha + MARK)."""
from __future__ import annotations
import json, re
import numpy as np
import cv2
import round8_scene as R8
import round13_anim as A
import round34_common as C

MARK = "<!-- ROUND34 badge -->"
META = C.SVG / "badge-split-r34.json"
ID = "belt-id.png"
ANIMS = ("full.hop", "full.squat", "full.step")


def badge_mask(im):
    cm = C.colour_masks(im)
    H, W = im.shape[:2]
    yy, xx = np.mgrid[:H, :W]
    col = cm["orange"] | cm["silver"] | cm["white"]
    lan = (xx >= 16) & (xx <= 36) & (yy <= 80) & col
    core = (xx >= 21) & (xx <= 31) & (yy >= 17) & (yy <= 80)
    top = (xx >= 19) & (xx <= 33) & (yy <= 17) & (cm["orange"] | cm["silver"] | (cm["lum"] > 60))
    card = np.zeros((H, W), np.uint8)
    cv2.rectangle(card, (6, 79), (46, 158), 1, -1)
    m = lan | core | top | (card > 0)
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    rim = (cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & ~m & ((cm["chroma"] > 30) | (cm["lum"] > 90))
    return (m | rim) & (cm["a"] > 0)


def split():
    if META.exists():
        meta = json.loads(META.read_text())
        if C.sha(C.SVG / ID) == meta.get("id_sha"):
            print("badge already split"); return meta
    im = C.load(ID)
    m = badge_mask(im)
    rest = im.copy(); rest[m] = 0
    cm = C.colour_masks(rest)
    opaque = rest[:, :, 3] > 0
    to_orange = opaque & cm["orange"]
    to_shorts = opaque & ~to_orange
    sh = C.load("shorts.png"); so = C.load("shorts-side-orange.png")
    n_sh = C.put("shorts.png", sh, ID, rest, to_shorts)
    n_so = C.put("shorts-side-orange.png", so, ID, rest, to_orange)
    C.put("shorts.png", sh, ID, np.zeros_like(rest), to_orange)
    hole_p = cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    tmp = np.zeros_like(sh)
    C.put("shorts.png", tmp, ID, np.full_like(im, 255), hole_p)
    hole = (tmp[:, :, 3] == 255) & (sh[:, :, 3] > 0)
    ctx = sh.copy(); ctx[hole] = 0
    cc = C.colour_masks(ctx)
    ctx[cc["orange"] | (cc["chroma"] > 45) | (cc["lum"] > 90)] = 0
    filled = C.crease_fill(ctx, hole, sigma=7.0, seed=344, grain=1.0)
    sh[hole, :3] = filled[hole, :3]
    sh[hole, 3] = 255
    out = np.zeros_like(im); out[m] = im[m]
    C.save(ID, out); C.save("shorts.png", sh); C.save("shorts-side-orange.png", so)
    meta = dict(badge_px=int(m.sum()), moved_to_shorts=n_sh, moved_to_side_orange=n_so, shorts_refilled=int(hole.sum()),
                id_sha=C.sha(C.SVG / ID), method="ROUND34c lanyard+card only; fabric/orange remainder moved; shorts refilled")
    META.write_text(json.dumps(meta, indent=2) + "\n")
    print("badge split", meta)
    return meta


def scene_edit(scene: str) -> str:
    if MARK in scene:
        return scene
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3200 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    ids = A.ids_by_name(scene)
    import round27_common as K
    h = K.hierarchy(scene)
    bone, pel = h["full.belt.id"], h["full.pelvis"]
    bw = (pel["x"] + bone["x"], pel["y"] + bone["y"])
    a, b = R8.find_elem(scene, "Image", "full.belt.id.image")
    tag = re.search(r"<Image [^>]*>", scene[a:b]).group(0)
    iid = re.search(r' id="([^"]+)"', tag).group(1); aid = re.search(r'assetId="([^"]+)"', tag).group(1)
    im = C.load(ID)
    ox, oy = C.art(*C.ORIGIN[ID])

    def wf(x, y):
        u = R8.smooth01((y - 440.0) / 12.0)
        return [1.0 - u, u]
    mesh = R8.grid_mesh("full.belt.id.image", (ox, oy), (im.shape[1], im.shape[0]), (8.0, 6.0), wf,
                        [(ids["full.pelvis"], (pel["x"], pel["y"])), (ids["full.belt.id"], bw)])
    xml = (f'<Image name="full.belt.id.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" '
           f'id="{iid}">{mesh}</Image>')
    scene = scene[:a] + xml + scene[b:]          # same draw slot (behind belt band, as before)
    bid = ids["full.belt.id"]
    for an in ANIMS:
        a2, b2 = R8.find_elem(scene, "LinearAnimation", an)
        if f'objectId="{bid}"' in scene[a2:b2]:
            raise SystemExit(f"{an} already keys badge bone")
        fr, rot, dy, _ = C.simulate(scene, an, "full.belt.id", L=70.0, hz=1.8, zeta=0.28, rmax=0.10, ymax=2.5)
        scene = R8.add_keys(scene, an, C.key_track(bid, "rotation", fr, rot) + C.key_track(bid, "y", fr, dy, base=bone["y"]))
        print(an, "badge lag max rot %.3f rad, dy %.2f px" % (abs(rot).max(), abs(dy).max()))
    needle = "<!-- ROUND34 pouch -->"
    scene = scene.replace(needle, needle + "\n    " + MARK, 1)
    return scene


def main():
    split()
    s = C.SCENE.read_text(encoding="utf-8")
    s2 = scene_edit(s)
    if s2 != s:
        C.SCENE.write_text(s2, encoding="utf-8")
    C.update_license({
        ID: "ROUND34c: lanyard + rings + clip + card only (skinned pelvis->badge bone); surrounding fabric moved out",
        "shorts.png": "ROUND34b/c: fabric from old pouch/badge crops moved in; areas under pouch/badge refilled (procedural)",
        "shorts-side-orange.png": "ROUND34b/c: orange strap scraps from old pouch/badge crops moved in",
    }, "ROUND34c: badge split + skinned lanyard.", "ROUND34c")
    C.hook_build("round34_badge.py", "round34_pouch.py")
    print("ROUND34c badge done")


if __name__ == "__main__":
    main()
