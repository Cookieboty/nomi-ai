#!/usr/bin/env python3
"""ROUND35a: real black choker + gold cross.

Background: R7 mis-named choker.png as the tank-top neckline (orange star);
the actual choker lives fused into mouth.png (neck/collarbone patch) and a few
edge pixels of head.png.  full.choker.image was torso-only skinned for that
neckline.

This round:
  1. MOVE tank-neckline pixels from choker.png into torso-tank.png (expand canvas up).
  2. Extract choker+cross from mouth.png (+ head scraps in the mouth ROI); backfill skin.
  3. Rewrite choker.png as the real accessory on the mouth mother box; reskin mesh to
     neck→torso so the band wraps the neck and the pendant blends onto the chest.
Idempotent via META sha + MARK.
"""
from __future__ import annotations
import json, re
import numpy as np
import cv2
from PIL import Image

import round8_scene as R8
import round13_anim as A
import round10_layers as L10
import round35_common as C

MARK = "<!-- ROUND35 choker -->"
META = C.SVG / "choker-split-r35.json"
HEAD = (480.0, 253.9)
TORSO = (480.0, 660.0)
NECK_LOCAL = (0.0, -186.1)  # under spine; used only for docs
# new choker lives on the mouth mother box (real accessory region)
CHOKER_BOX = [450, 250, 575, 310]  # 125x60


def mouth_choker_mask(im: np.ndarray) -> np.ndarray:
    r, g, b, a = (im[:, :, i].astype(np.float32) for i in range(4))
    lum = (r + g + b) / 3
    H, W = im.shape[:2]
    yy, xx = np.mgrid[:H, :W]
    dark = (a >= 120) & (lum < 95) & (r < 120)
    gold = (a >= 120) & (r > 170) & (g > 120) & (b < 140) & ((r - b) > 60) & ((g - b) > 30)
    ora = (a >= 120) & (r > 160) & (g > 70) & (g < 200) & (b < 110) & ((r - g) > 25) & ((r - b) > 45)
    center = (xx > 35) & (xx < 90) & (yy > 10) & (yy < 50)
    band_zone = (yy >= 15) & (yy <= 32)
    m = (dark & (band_zone | center)) | ((gold | ora) & center)
    m |= dark & center & (lum < 110)
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    dil = cv2.dilate(m.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    fringe = dil & ~m & (a >= 8)
    warm = ((r > 150) & ((r - b) > 40)) | (lum < 100)
    m |= fringe & warm
    return m & (a > 0)


def head_choker_scraps(hd: np.ndarray, hb, mb) -> tuple[np.ndarray, np.ndarray]:
    """Conservative: only gold/orange pendant AA near mouth-ROI center (mouth owns the band)."""
    y0, y1 = mb[1] - hb[1], mb[3] - hb[1]
    x0, x1 = mb[0] - hb[0], mb[2] - hb[0]
    roi = hd[y0:y1, x0:x1]
    r, g, b, a = (roi[:, :, i].astype(np.float32) for i in range(4))
    gold = (a >= 180) & (r > 175) & (g > 130) & (b < 130) & ((r - b) > 60)
    ora = (a >= 180) & (r > 165) & (g > 70) & (g < 195) & (b < 105) & ((r - g) > 30) & ((r - b) > 50)
    H, W = roi.shape[:2]
    yy, xx = np.mgrid[:H, :W]
    center = (xx > 40) & (xx < W - 40) & (yy > 15) & (yy < 50)
    m = (gold | ora) & center
    # tiny dark pixels glued to pendant
    lum = (r + g + b) / 3
    dark = (a >= 180) & (lum < 80) & (r < 100)
    dil = cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    m |= dark & dil & center
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8)) > 0
    m &= a > 0
    full = np.zeros(hd.shape[:2], bool)
    full[y0:y1, x0:x1] = m
    panel = np.zeros_like(roi)
    panel[m] = roi[m]
    return full, panel


def move_tank_neckline():
    """Move legacy choker.png (tank neckline) into torso-tank.png, expanding canvas upward."""
    old = C.load("choker.png")
    old_sha = C.sha(C.SVG / "choker.png")
    tank = C.load("torso-tank.png")
    bx = C.boxes()
    cb, tb = bx["choker"], bx["torso-tank"]
    # If choker box already equals CHOKER_BOX, neckline was moved earlier
    if cb == CHOKER_BOX:
        print("tank neckline already moved (choker box is mouth region)")
        return dict(tank_box=tb, moved_neckline_px=0, old_choker_sha=old_sha, skipped=True)
    nx0 = min(cb[0], tb[0])
    ny0 = min(cb[1], tb[1])
    nx1 = max(cb[2], tb[2])
    ny1 = max(cb[3], tb[3])
    new = np.zeros((ny1 - ny0, nx1 - nx0, 4), np.uint8)
    ty, tx = tb[1] - ny0, tb[0] - nx0
    new[ty : ty + tank.shape[0], tx : tx + tank.shape[1]] = tank
    cy, cx = cb[1] - ny0, cb[0] - nx0
    region = new[cy : cy + old.shape[0], cx : cx + old.shape[1]]
    src_a = old[:, :, 3]
    dst_a = region[:, :, 3]
    take = (src_a >= 8) & ((src_a >= dst_a) | (dst_a < 8))
    moved = int(take.sum())
    region[take] = old[take]
    new[cy : cy + old.shape[0], cx : cx + old.shape[1]] = region
    C.save("torso-tank.png", new)
    C.ORIGIN["torso-tank.png"] = (nx0, ny0)
    C.set_box("torso-tank", [nx0, ny0, nx1, ny1])
    # keep underlayer-top canvas in sync (same box; no neckline content)
    up = C.SVG / "underlayer-top.png"
    if up.exists():
        old_u = np.array(Image.open(up).convert("RGBA"))
        # old underlayer matched previous tank box
        new_u = np.zeros((ny1 - ny0, nx1 - nx0, 4), np.uint8)
        uy, ux = tb[1] - ny0, tb[0] - nx0
        new_u[uy : uy + old_u.shape[0], ux : ux + old_u.shape[1]] = old_u
        C.save("underlayer-top.png", new_u)
    return dict(tank_box=[nx0, ny0, nx1, ny1], moved_neckline_px=moved, old_choker_sha=old_sha)


def split_textures():
    if META.exists():
        meta = json.loads(META.read_text())
        if (C.SVG / "choker.png").exists() and C.sha(C.SVG / "choker.png") == meta.get("choker_sha"):
            # also verify mouth low-choker
            mouth = C.load("mouth.png")
            if int(mouth_choker_mask(mouth).sum()) < 40:
                print("choker already split", meta.get("choker_px"))
                return meta

    stats = {}
    # 1) move tank neckline out of choker.png into tank
    tank_info = move_tank_neckline()
    stats.update(tank_info)

    # 2) extract from mouth
    mouth = C.load("mouth.png")
    mm = mouth_choker_mask(mouth)
    panel = np.zeros_like(mouth)
    panel[mm] = mouth[mm]
    mouth2 = C.backfill_skin(mouth, mm)
    # force peach where residual dark/gold remains inside the hole
    a = mouth2[:, :, 3].astype(np.float32)
    r, g, b = (mouth2[:, :, i].astype(np.float32) for i in range(3))
    skin = (a >= 180) & ~mm & (r > 190) & (g > 140) & (b > 100)
    mean = mouth2[:, :, :3][skin].mean(0) if skin.any() else np.array([250.0, 220.0, 205.0])
    lum = (r + g + b) / 3
    bad = mm & (((lum < 120) & (r < 150)) | ((r > 170) & ((r - b) > 55) & (b < 130)))
    mouth2[bad, :3] = mean.astype(np.uint8)
    # soften
    if bad.any():
        blur = cv2.GaussianBlur(mouth2[:, :, :3], (0, 0), 0.8)
        mouth2[mm, :3] = (0.65 * mouth2[mm, :3].astype(float) + 0.35 * blur[mm].astype(float)).astype(np.uint8)
    stats["mouth_px"] = int(mm.sum())

    # 3) head scraps in mouth ROI
    hd = C.load("head.png")
    hb, mb = C.boxes()["head"], CHOKER_BOX
    hmask, hpanel = head_choker_scraps(hd, hb, mb)
    # merge head scraps into panel where panel empty
    take = (hpanel[:, :, 3] >= 8) & (panel[:, :, 3] < 8)
    panel[take] = hpanel[take]
    # also overlay head scraps that are gold/orange onto panel (pendant AA)
    take2 = (hpanel[:, :, 3] >= 8) & (panel[:, :, 3] >= 8)
    # prefer higher chroma from either
    panel[take2] = hpanel[take2]  # head edge AA over mouth — rare
    stats["head_scrap_px"] = int(hmask.sum())
    stats["merged_from_head"] = int(take.sum())
    hd2 = hd.copy()
    if hmask.any():
        # only backfill where head had opaque choker scraps (not the transparent hole)
        hd2 = C.backfill_skin(hd, hmask)
        # for scraps that sat on transparent-adjacent: just clear them
        # backfill_skin already rewrote RGB; keep alpha

    # 4) write new choker.png (= mouth canvas / CHOKER_BOX)
    C.save("choker.png", panel)
    C.save("mouth.png", mouth2)
    C.save("head.png", hd2)
    C.ORIGIN["choker.png"] = (CHOKER_BOX[0], CHOKER_BOX[1])
    C.set_box("choker", CHOKER_BOX)

    stats.update(
        choker_px=int((panel[:, :, 3] >= 8).sum()),
        choker_sha=C.sha(C.SVG / "choker.png"),
        mouth_sha=C.sha(C.SVG / "mouth.png"),
        head_sha=C.sha(C.SVG / "head.png"),
        tank_sha=C.sha(C.SVG / "torso-tank.png"),
        method="ROUND35a: real choker from mouth(+head scraps); tank neckline moved into torso-tank",
    )
    META.write_text(json.dumps(stats, indent=2) + "\n")
    print("choker split", {k: stats[k] for k in ("mouth_px", "head_scrap_px", "choker_px", "moved_neckline_px", "tank_box")})
    return stats


def w_choker(mx: float, my: float) -> list[float]:
    """neck share high on the band (my~280), blends to torso toward pendant bottom (my~310)."""
    # neck pivot ~300; chin ~222
    sm = R8.smooth01
    # band rows → neck; lower pendant → torso
    neck = sm((305.0 - my) / 25.0)  # 1 above 305, 0 below 280… wait
    # my 250 → 1, my 310 → 0
    neck = sm((310.0 - my) / 40.0)
    return [neck, 1.0 - neck]


def reskin_choker(scene: str) -> str:
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3600 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    # origin of full.choker bone world ≈ head + (0,40)
    o = (HEAD[0], HEAD[1] + 40.0)
    nk = ids.get("full.neck") or ids["full.head"]
    tq = ids["full.torso"]
    # prefer neck bone if present; fall back to head
    bones = [
        (nk, (0.0, 0.0) if nk == ids.get("full.neck") else (HEAD[0] - o[0], HEAD[1] - o[1])),
        (tq, (TORSO[0] - o[0], TORSO[1] - o[1])),
    ]
    # If using neck: neck world at rest = torso + spine + neck offsets.
    # full.choker is child of neck at (0,40); image parent_origin should be choker world.
    # Simpler robust approach matching R13 collar: weight head+torso with neck-column field,
    # parent_origin = choker world o.
    if "full.neck" in ids:
        # bone positions relative to image parent (choker): neck is parent of choker, so neck local (0,-40) from choker
        bones = [
            (ids["full.neck"], (0.0, -40.0)),
            (ids["full.torso"], (TORSO[0] - o[0], TORSO[1] - o[1])),
        ]

    def wf(x, y):
        mx, my = (x + o[0] - R8.OX) / C.S, (y + o[1] - R8.OY) / C.S
        return w_choker(mx, my)

    # denser rows across the band
    def rows(box, dense=(250.0, 310.0), fine=3.0, coarse=10.0):
        y0, y1 = box[1], box[3]
        ys, y = [float(y0)], float(y0)
        while y < y1:
            y += fine if dense[0] <= y < dense[1] else coarse
            ys.append(min(y, float(y1)))
        return [(v - y0) / (y1 - y0) for v in ys]

    a, b = R8.find_elem(scene, "Image", "full.choker.image")
    tag = re.search(r"<Image [^>]*>", scene[a:b]).group(0)
    iid = re.search(r' id="([^"]+)"', tag).group(1)
    aid = re.search(r'assetId="([^"]+)"', tag).group(1)
    xml = R8.image_mesh(
        "full.choker.image",
        aid,
        CHOKER_BOX,
        (6.0, 6.0),
        wf,
        bones,
        parent_origin=o,
        row_edges=rows(CHOKER_BOX),
    )
    xml = re.sub(r'^(<Image [^>]*?) id="[^"]+">', lambda q: f'{q.group(1)} id="{iid}">', xml, count=1)
    scene = scene[:a] + xml + scene[b:]
    return scene


def reskin_tank(scene: str) -> str:
    """Refresh tank mesh for expanded canvas; keep R28 torso/spine/pelvis shares."""
    import round27_common as K
    bx = C.boxes()["torso-tank"]
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3610 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    a, b = R8.find_elem(scene, "Image", "full.torso.tank.image")
    tag = re.search(r"<Image [^>]*>", scene[a:b]).group(0)
    iid = re.search(r' id="([^"]+)"', tag).group(1)
    aid = re.search(r'assetId="([^"]+)"', tag).group(1)
    fk = K.FK(scene)
    wpos = lambda n: fk.world(n)[:2, 2]
    tw, sw, pw = wpos("full.torso"), wpos("full.spine"), wpos("full.pelvis")
    TQ, SQ, PQ = ids["full.torso"], ids["full.spine"], ids["full.pelvis"]
    # image sits on torso; grid at mother-box top-left in PARENT (torso) space
    ax, ay = C.art(bx[0], bx[1])
    ox, oy = ax - tw[0], ay - tw[1]
    w, hh = bx[2] - bx[0], bx[3] - bx[1]

    def shares(y):
        aa = R8.smooth01((y - 560.0) / 50.0)
        c = 1.0 - R8.smooth01((y - 330.0) / 120.0)
        return aa, (1 - aa) * c, (1 - aa) * (1 - c)  # pelvis, spine, torso

    def wt(x, y):
        p, c, t = shares(y + tw[1])
        return [t, c, p]

    mesh = R8.grid_mesh(
        "full.torso.tank.image",
        (ox, oy),
        (w, hh),
        (6.0, 6.0),
        wt,
        [(TQ, (0.0, 0.0)), (SQ, (0.0, sw[1] - tw[1])), (PQ, (pw[0] - tw[0], pw[1] - tw[1]))],
    )
    xml = (
        f'<Image name="full.torso.tank.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" '
        f'scaleX="1" scaleY="1" id="{iid}">{mesh}</Image>'
    )
    scene = scene[:a] + xml + scene[b:]
    return scene



def reskin_underlayer(scene: str) -> str:
    """Match underlayer-top mesh to expanded tank canvas (clone of tank placement)."""
    if "full.underlayer.top.image" not in scene:
        return scene
    import round27_common as K
    bx = C.boxes()["torso-tank"]
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3620 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    a, b = R8.find_elem(scene, "Image", "full.underlayer.top.image")
    tag = re.search(r"<Image [^>]*>", scene[a:b]).group(0)
    iid = re.search(r' id="([^"]+)"', tag).group(1)
    aid = re.search(r'assetId="([^"]+)"', tag).group(1)
    fk = K.FK(scene)
    wpos = lambda n: fk.world(n)[:2, 2]
    tw, sw, pw = wpos("full.torso"), wpos("full.spine"), wpos("full.pelvis")
    TQ, SQ, PQ = ids["full.torso"], ids["full.spine"], ids["full.pelvis"]
    ax, ay = C.art(bx[0], bx[1])
    ox, oy = ax - tw[0], ay - tw[1]
    w, hh = bx[2] - bx[0], bx[3] - bx[1]

    def shares(y):
        aa = R8.smooth01((y - 560.0) / 50.0)
        c = 1.0 - R8.smooth01((y - 330.0) / 120.0)
        return aa, (1 - aa) * c, (1 - aa) * (1 - c)

    def wt(x, y):
        p, c, t = shares(y + tw[1])
        return [t, c, p]

    mesh = R8.grid_mesh(
        "full.underlayer.top.image",
        (ox, oy),
        (w, hh),
        (6.0, 6.0),
        wt,
        [(TQ, (0.0, 0.0)), (SQ, (0.0, sw[1] - tw[1])), (PQ, (pw[0] - tw[0], pw[1] - tw[1]))],
    )
    xml = (
        f'<Image name="full.underlayer.top.image" assetId="{aid}" x="0" y="0" originX="0" originY="0" '
        f'scaleX="1" scaleY="1" id="{iid}">{mesh}</Image>'
    )
    return scene[:a] + xml + scene[b:]


def insert_mark(scene: str) -> str:
    if MARK in scene:
        return scene
    needle = "<!-- ROUND34 badge -->"
    if needle in scene:
        return scene.replace(needle, needle + "\n    " + MARK, 1)
    return re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)


def main():
    meta = split_textures()
    scene = C.SCENE.read_text(encoding="utf-8")
    if MARK not in scene or meta.get("force"):
        scene = reskin_choker(scene)
        scene = reskin_tank(scene)
        scene = reskin_underlayer(scene)
        scene = insert_mark(scene)
        C.SCENE.write_text(scene, encoding="utf-8")
        print("scene updated")
    else:
        print("scene mark present; textures refreshed if needed")
    C.update_license(
        {
            "choker.png": "ROUND35a: real black choker + gold cross extracted from mouth/head; tank neckline vacated",
            "mouth.png": "ROUND35a: choker pixels moved out; neck skin backfilled",
            "head.png": "ROUND35a: choker edge scraps removed; skin backfilled",
            "torso-tank.png": "ROUND35a: absorbed legacy choker.png tank-neckline (canvas expanded up)",
        },
        "ROUND35a: real choker split from mouth/head; tank neckline into torso-tank.",
        "ROUND35a",
    )
    C.hook_build("round35_choker.py", "round34_badge.py")
    print("ROUND35a choker done", meta.get("choker_px"))


if __name__ == "__main__":
    main()
