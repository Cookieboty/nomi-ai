#!/usr/bin/env python3
"""ROUND34b: waist pouch.  belt-pouch.png was a rigid rectangle-ish crop: pouch + its belt strap/clip AND the shorts
fabric / orange strap ends around it; it hung rigidly on RootBone full.belt.pouch (child of pelvis) with sway keyed
only in idle.

* belt-pouch.png keeps only the pouch (bag + flap + emblem + cord), its dark hanger strap and the orange clip/ring.
* Non-pouch pixels MOVE: orange -> shorts-side-orange.png, the rest -> shorts.png (they replace shorts' old flat
  backfill with real source fabric where they exist).
* Under the pouch shorts.png is re-inpainted (Telea+NS from surrounding fabric, grain) instead of the flat R-old patch.
* full.belt.pouch.image becomes a skinned grid mesh: hanger rows (y<=446) on pelvis, blending to the pouch bone by
  y=462, bag on bone.  Bone keeps idle keys; walk/run/hop/squat/step get damped-pendulum lag (pivot world accel +
  pelvis rotation) + small vertical bounce keys.
Idempotent (meta json stores post-split pouch sha; scene MARK)."""
from __future__ import annotations
import json, re
import numpy as np
import cv2
import round8_scene as R8
import round13_anim as A
import round34_common as C

MARK = "<!-- ROUND34 pouch -->"
META = C.SVG / "pouch-split-r34.json"
POUCH = "belt-pouch.png"
COAT = "coat-r-front.png"
PW, PH = 96, 112
ANIMS = ("full.walk", "full.run", "full.hop", "full.squat", "full.step")
BAG = [(527, 458), (545, 452), (567, 453), (573, 462), (587, 500), (581, 513), (560, 516), (548, 521), (528, 515), (525, 470)]
STRAP = [(534, 429), (552, 429), (554, 458), (537, 461)]
CLIP = [(516, 444), (537, 444), (537, 470), (516, 470)]


def world_origin(name):
    mx, my = C.ORIGIN[name]
    return C.art(mx, my)


def poly(pts, shape):
    ox, oy = world_origin(POUCH)
    m = np.zeros(shape[:2], np.uint8)
    cv2.fillPoly(m, [np.round(np.array([((x - ox) / C.S, (y - oy) / C.S) for x, y in pts])).astype(np.int32)], 1)
    return m > 0


def pouch_mask(im):
    cm = C.colour_masks(im)
    m = poly(BAG, im.shape) | poly(STRAP, im.shape) | (poly(CLIP, im.shape) & (cm["orange"] | cm["silver"] | (cm["lum"] < 40)))
    return m & (cm["a"] > 0)


def coat_edge_line(coat, y0, y1):
    """left edge of the coat panel just above/below the bag rows (coat grid) -> x(y) linear"""
    def left(y):
        xs = np.nonzero(coat[y, :, 3] >= 128)[0]
        return float(xs[0]) if len(xs) else None
    ya, yb = y0, y1
    while left(ya) is None and ya > 0:
        ya -= 1
    while left(yb) is None and yb < coat.shape[0] - 1:
        yb += 1
    xa, xb = left(ya), left(yb)
    return lambda y: xa + (xb - xa) * (y - ya) / max(yb - ya, 1)


def split():
    if META.exists():
        meta = json.loads(META.read_text())
        if C.sha(C.SVG / POUCH) == meta.get("pouch_sha"):
            print("pouch already split"); return meta
    src = C.load(POUCH)
    im = np.zeros((PH, PW, 4), np.uint8)            # canvas grown right/down so the whole bag fits
    im[: src.shape[0], : src.shape[1]] = src
    m = pouch_mask(im)
    coat = C.load(COAT)
    cw = C.window(COAT, coat, POUCH, im.shape)
    ccm = C.colour_masks(cw)
    bagc = poly(BAG, im.shape) & (cw[:, :, 3] > 0) & ((ccm["lum"] < 175) | ccm["orange"])
    bagc = cv2.morphologyEx(bagc.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)) > 0
    # coat's opaque non-bag pixels covered pouch texels before (coat was drawn in front): those texels were hidden dups
    covered = m & ~bagc & (cw[:, :, 3] >= 200)
    out = np.zeros_like(im); out[m] = im[m]
    out[covered] = 0
    out[bagc] = cw[bagc]
    pm = m & ~covered | bagc
    # remove bag strip from coat + white backfill right of the coat edge line
    gone = np.zeros(coat.shape[:2], np.uint8)
    tmp = np.zeros_like(coat)
    C.put(COAT, tmp, POUCH, np.full_like(im, 255), bagc)
    gone = tmp[:, :, 3] == 255
    ys = np.nonzero(gone.any(1))[0]
    coat_ctx = coat.copy(); coat_ctx[gone] = 0
    edge = coat_edge_line(coat_ctx, int(ys.min()) - 2, int(ys.max()) + 2) if len(ys) else None
    coat[gone] = 0
    n_coat_fill = 0
    if edge is not None:
        yy, xx = np.nonzero(gone)
        right = np.zeros_like(gone)
        sel = xx >= np.array([edge(y) for y in yy]) - 0.5
        right[yy[sel], xx[sel]] = True
        cc = C.colour_masks(coat_ctx)
        ctx = coat_ctx.copy(); ctx[(cc["lum"] < 170) | cc["orange"] | (cc["chroma"] > 40)] = 0     # white-coat context only
        f = C.fabric_fill(ctx, right, seed=343, grain=0.8, blur=1.0)
        coat[right] = f[right]
        n_coat_fill = int(right.sum())
    # remainder of the old crop -> shorts / side-orange
    rest = im.copy(); rest[m] = 0
    cm = C.colour_masks(rest)
    opaque = rest[:, :, 3] > 0
    to_orange = opaque & cm["orange"]
    to_coat = opaque & ~to_orange & (cm["lum"] >= 120)          # white coat/sleeve AA caught in the old crop
    to_shorts = opaque & ~to_orange & ~to_coat
    sh = C.load("shorts.png"); so = C.load("shorts-side-orange.png")
    cwin = C.window(COAT, coat, POUCH, im.shape)
    to_coat &= cwin[:, :, 3] < 128
    n_ct = C.put(COAT, coat, POUCH, rest, to_coat)
    n_light_under_coat = int((opaque & ~to_orange & (cm["lum"] >= 120) & ~to_coat).sum())  # hidden under opaque coat: dropped
    n_sh = C.put("shorts.png", sh, POUCH, rest, to_shorts)
    n_so = C.put("shorts-side-orange.png", so, POUCH, rest, to_orange)
    C.put("shorts.png", sh, POUCH, np.zeros_like(rest), to_orange)
    # re-inpaint shorts under the pouch (old flat patch), inside shorts' own silhouette
    hole_p = cv2.dilate((m & ~bagc).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    tmp = np.zeros_like(sh)
    C.put("shorts.png", tmp, POUCH, np.full_like(im, 255), hole_p)
    hole = (tmp[:, :, 3] == 255) & (sh[:, :, 3] > 0)
    ctx = sh.copy(); ctx[hole] = 0
    cc = C.colour_masks(ctx)
    ctx[cc["orange"] | (cc["chroma"] > 45) | (cc["lum"] > 90)] = 0      # dark fabric context only
    filled = C.crease_fill(ctx, hole, sigma=9.0, seed=342, grain=1.0)
    sh[hole, :3] = filled[hole, :3]
    sh[hole, 3] = 255
    C.save(POUCH, out); C.save("shorts.png", sh); C.save("shorts-side-orange.png", so); C.save(COAT, coat)
    meta = dict(pouch_px=int((out[:, :, 3] > 0).sum()), from_old_crop=int((m & ~covered).sum()), from_coat_r_front=int(bagc.sum()),
                hidden_dups_dropped=int(covered.sum()), coat_white_backfill=n_coat_fill,
                moved_to_shorts=n_sh, moved_light_to_coat=n_ct, light_dups_under_coat=n_light_under_coat, moved_to_side_orange=n_so, shorts_inpainted=int(hole.sum()),
                canvas=[PW, PH], pouch_sha=C.sha(C.SVG / POUCH),
                method="ROUND34b pouch-only texture (+bag strip from coat-r-front); remainder moved; shorts/coat backfilled")
    META.write_text(json.dumps(meta, indent=2) + "\n")
    print("pouch split", meta)
    return meta


def scene_edit(scene: str) -> str:
    if MARK in scene:
        return scene
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3200 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    ids = A.ids_by_name(scene)
    import round27_common as K
    h = K.hierarchy(scene)
    bone = h["full.belt.pouch"]
    pel = h["full.pelvis"]
    bw = (pel["x"] + bone["x"], pel["y"] + bone["y"])
    a, b = R8.find_elem(scene, "Image", "full.belt.pouch.image")
    tag = re.search(r"<Image [^>]*>", scene[a:b]).group(0)
    iid = re.search(r' id="([^"]+)"', tag).group(1); aid = re.search(r'assetId="([^"]+)"', tag).group(1)
    w, hgt = C.load(POUCH).shape[1], C.load(POUCH).shape[0]
    ox, oy = world_origin(POUCH)

    def wf(x, y):
        u = R8.smooth01((y - 446.0) / 16.0)
        return [1.0 - u, u]
    mesh = R8.grid_mesh("full.belt.pouch.image", (ox, oy), (w, hgt), (8.0, 8.0), wf,
                        [(ids["full.pelvis"], (pel["x"], pel["y"])), (ids["full.belt.pouch"], bw)])
    xml = (f'<Image name="full.belt.pouch.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" '
           f'id="{iid}">{mesh}</Image>')
    scene = scene[:a] + scene[b:]                      # out of the bone (skinned: parent transform unused)
    i = scene.index('<Image name="full.coat-r.front.image"')
    scene = scene[:i] + xml + "\n" + scene[i:]         # bag is in front of the coat edge (art); arm-r upper stays in front
    bid = ids["full.belt.pouch"]
    for an in ANIMS:
        fr, rot, dy, _ = C.simulate(scene, an, "full.belt.pouch", L=45.0, hz=2.2, zeta=0.30, rmax=0.10, ymax=2.0)
        xml = C.key_track(bid, "rotation", fr, rot) + C.key_track(bid, "y", fr, dy, base=bone["y"])
        a2, b2 = R8.find_elem(scene, "LinearAnimation", an)
        blk = scene[a2:b2]
        if f'objectId="{bid}"' in blk:
            raise SystemExit(f"{an} already keys pouch bone")
        scene = R8.add_keys(scene, an, xml)
        print(an, "pouch lag max rot %.3f rad, dy %.2f px" % (abs(rot).max(), abs(dy).max()))
    needle = "<!-- ROUND34 belt -->"
    scene = scene.replace(needle, needle + "\n    " + MARK, 1)
    return scene


def main():
    split()
    s = C.SCENE.read_text(encoding="utf-8")
    s2 = scene_edit(s)
    if s2 != s:
        C.SCENE.write_text(s2, encoding="utf-8")
    C.update_license({
        POUCH: "ROUND34b: pouch + hanger strap + clip only (skinned pelvis->pouch bone); surrounding fabric/orange moved out",
        "shorts.png": "ROUND34b: fabric from old pouch crop moved in; under-pouch area Telea/NS inpainted (procedural)",
        "shorts-side-orange.png": "ROUND34b: orange strap ends from old pouch crop moved in",
        COAT: "ROUND34b: pouch strip moved out to belt-pouch.png; white coat edge inpainted behind it",
    }, "ROUND34b: pouch split + skinned with lag.", "ROUND34b")
    C.hook_build("round34_pouch.py", "round34_belt.py")
    print("ROUND34b pouch done")


if __name__ == "__main__":
    main()
