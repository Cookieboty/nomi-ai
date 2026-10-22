#!/usr/bin/env python3
"""ROUND14 item 3 — brows: clean per-brow layers on their own bones + small expression keys.

Root cause: the R7 "brow-l/r" crops never held brows (they held the outer upper-lash corners, now moved into the eye
layers by round14_eyes.py); the brows are the thin dark lines this art paints OVER the bangs (mother L x 446-481,
y 130-139; R x 518-549, y 122-132) and they lived inside head.png, so full.brow.l (keyed by puzzled) rotated lash scraps.
Fix:
  * brow line = px darker than the local median (9 px) by > 22 and lum < 120 inside a band per brow, long thin components
    only, + 1 px anti-aliased fringe; moved (not copied) out of every head-group crop into brow-l/r.png;
  * the hair under the line is synthesized from the neighbouring bangs (cv2 TELEA inpaint, radius 3) and written back into
    head.png at those px, so a moved brow reveals hair, never a hole;
  * leftover lash scraps of the old brow crops: hidden ones dropped, visible ones composited into head.png (it was in front);
  * full.brow.l/r re-anchored at the brow centres; the brow images move in front of head.png (they are painted over the
    bangs); keys: surprise raise, angry frown, aggrieved/tears/apology/shy inner raise (puzzled kept).
Runs after round14_eyes.py."""
from __future__ import annotations

import hashlib
import json
import re

import cv2
import numpy as np
from PIL import Image

import round8_scene as R8
import round13_anim as A
import round13_hair as HR
import round10_layers as L10

PROJECT, OUT = L10.PROJECT, L10.OUT
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
H, W = HR.H, HR.W
HEAD = (480.0, 253.9)
BAND = {"l": (436, 128, 486, 140), "r": (518, 122, 578, 136)}
# (clip, [(frac, dy_art, rot_l)]) ; r mirrors rot
EXPR = {
    "full.surprise": [(0, 0, 0), (0.2, -2.5, 0.0), (0.75, -2.5, 0.0), (1, 0, 0)],
    "full.angry": [(0, 0, 0), (0.2, 1.0, 0.12), (0.75, 1.0, 0.12), (1, 0, 0)],
    "full.aggrieved": [(0, 0, 0), (0.25, -1.0, -0.10), (0.75, -1.0, -0.10), (1, 0, 0)],
    "full.tears": [(0, 0, 0), (0.25, -1.0, -0.10), (0.75, -1.0, -0.10), (1, 0, 0)],
    "full.apology": [(0, 0, 0), (0.25, -0.8, -0.08), (0.75, -0.8, -0.08), (1, 0, 0)],
    "full.shy": [(0, 0, 0), (0.25, -0.6, -0.06), (0.75, -0.6, -0.06), (1, 0, 0)],
}


def main():
    scene = SCENE.read_text(encoding="utf-8")
    lic = json.loads(LICENSE.read_text())
    boxes = json.loads(L10.META.read_text())["boxes"]
    ids = A.ids_by_name(scene)
    anims = A.animations(scene)
    cv = {n: HR.canvas(n, boxes) for n in HR.LAYERS}
    # 0) leftover scraps of the old brow crops: fold into head (head was drawn in front of them)
    eye_skin = np.zeros((H, W), bool)
    for s in "lr":
        b = boxes[f"eye-{s}-skin"]
        eye_skin[b[1]:b[3], b[0]:b[2]] |= np.array(Image.open(OUT / f"eye-{s}-skin.png"))[..., 3] == 255
    rep = {"scraps": {}, "brows": {}}
    for s in "lr":
        n = f"brow-{s}"
        a = cv[n][..., 3] > 0
        hid = a & eye_skin
        vis = a & ~eye_skin
        under = np.where(vis[..., None], cv[n], 0).astype(np.uint8)
        cv["head"] = HR.over(under, cv["head"])
        rep["scraps"][n] = {"hidden_dropped": int(hid.sum()), "folded_into_head": int(vis.sum())}
        cv[n][:] = 0
    comp = np.zeros((H, W, 4), np.uint8)
    for n in HR.LAYERS:
        comp = HR.over(comp, cv[n])
    c = comp.astype(np.float32)
    lum = 0.3 * c[..., 0] + 0.59 * c[..., 1] + 0.11 * c[..., 2]
    bg = cv2.medianBlur(np.clip(lum, 0, 255).astype(np.uint8), 9).astype(np.float32)
    for s, (x0, y0, x1, y1) in BAND.items():
        m = np.zeros((H, W), bool)
        m[y0:y1, x0:x1] = True
        core = m & (lum < bg - 22) & (lum < 120)
        n_, lab, st, _ = cv2.connectedComponentsWithStats(core.astype(np.uint8), 8)
        keep = np.zeros_like(core)
        for i in range(1, n_):
            _, _, w, h, _ = st[i]
            if w >= 8 and w > 2.5 * h:
                keep |= lab == i
        fringe = (cv2.dilate(keep.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & ~keep & (lum < bg - 8) & m
        bm = keep | fringe
        brow = np.where(bm[..., None], comp, 0).astype(np.uint8)
        # hair under the line, synthesized from the neighbouring bangs
        ys, xs = np.where(bm)
        bx0, bx1, by0, by1 = xs.min() - 8, xs.max() + 9, ys.min() - 8, ys.max() + 9
        sub = np.ascontiguousarray(comp[by0:by1, bx0:bx1, :3])
        hole = (cv2.dilate(bm.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)[by0:by1, bx0:bx1]
        fill = cv2.inpaint(sub, hole.astype(np.uint8) * 255, 3, cv2.INPAINT_TELEA)
        moved = {}
        for n in HR.LAYERS:
            sel = bm & (cv[n][..., 3] > 0)
            if sel.any():
                moved[n] = int(sel.sum())
                cv[n][sel] = 0
        hb = bm[by0:by1, bx0:bx1]
        hd = cv["head"][by0:by1, bx0:bx1]
        hd[hb, :3] = fill[hb]
        hd[hb, 3] = comp[by0:by1, bx0:bx1][hb, 3]
        bb = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        name = f"brow-{s}"
        old = boxes[name]
        Image.fromarray(brow[bb[1]:bb[3], bb[0]:bb[2]]).save(OUT / f"{name}.png")
        cv[name] = brow                                  # keep it through the final write-back of the crops
        boxes[name] = bb
        cxm, cym = (xs.mean(), ys.mean())
        bxa, bya = R8.art(cxm, cym)
        rep["brows"][s] = {"px": int(bm.sum()), "core": int(keep.sum()), "moved_from": moved, "box": bb,
                           "centre_mother": [round(float(cxm), 1), round(float(cym), 1)], "hair_fill_px": int(hb.sum())}
        # re-anchor bone, re-position image
        bn = f"full.brow.{s}"
        mb = re.search(rf'<RootBone name="{re.escape(bn)}"[^>]*>', scene)
        tag = re.sub(r' x="[^"]*"', f' x="{bxa - HEAD[0]:.4f}"', mb.group(0), count=1)
        tag = re.sub(r' y="[^"]*"', f' y="{bya - HEAD[1]:.4f}"', tag, count=1)
        scene = scene[:mb.start()] + tag + scene[mb.end():]
        ax, ay = R8.art(bb[0], bb[1])
        mi = re.search(rf'<Image name="{re.escape(bn)}\.image"[^>]*>', scene)
        itag = re.sub(r' x="[^"]*"', f' x="{ax - bxa:.4f}"', mi.group(0), count=1)
        itag = re.sub(r' y="[^"]*"', f' y="{ay - bya:.4f}"', itag, count=1)
        scene = scene[:mi.start()] + itag + scene[mi.end():]
        txt = L10.META.read_text()
        txt = txt.replace(f'"{name}": {old}', f'"{name}": {bb}', 1)
        json.loads(txt)
        L10.META.write_text(txt)
    # move the two brow bones (with their images) out of full.face to just in front of head.image
    xml = ""
    for s in "lr":
        a, b = R8.find_elem(scene, "RootBone", f"full.brow.{s}")
        xml += scene[a:b] + "\n"
        scene = scene[:a] + scene[b:]
    i = scene.index('<Image name="full.head.image"')
    i = scene.rfind("\n", 0, i) + 1
    scene = scene[:i] + xml + scene[i:]
    # expression keys
    for clip, pts in EXPR.items():
        dur = anims[clip][0]
        keys = ""
        for s, sg in (("l", 1.0), ("r", -1.0)):
            bid = ids[f"full.brow.{s}"]
            bx = float(re.search(rf'<RootBone name="full\.brow\.{s}" x="([^"]+)" y="([^"]+)"', scene).group(1))
            by = float(re.search(rf'<RootBone name="full\.brow\.{s}" x="([^"]+)" y="([^"]+)"', scene).group(2))
            keys += R8.keyed(bid, "y", [(round(f * dur), by + dy) for f, dy, _ in pts])
            keys += R8.keyed(bid, "rotation", [(round(f * dur), sg * r) for f, _, r in pts])
        scene = R8.add_keys(scene, clip, keys)
    rep["expressions"] = list(EXPR)
    # puzzled: its brow.l rotation keys stay; its pivot is now the brow centre
    for n in HR.LAYERS:
        b = boxes[n]
        a = np.array(Image.open(OUT / f"{n}.png").convert("RGBA"))
        new = cv[n][b[1]:b[1] + a.shape[0], b[0]:b[0] + a.shape[1]]
        if not np.array_equal(new, a):
            Image.fromarray(new).save(OUT / f"{n}.png")
    if "ROUND14 brows" not in scene:
        scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n", "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND14 brows: brow lines on their own bones -->\n", 1)
    SCENE.write_text(scene, encoding="utf-8")
    for n in HR.LAYERS:
        rel = f"reference/svg-rig/{n}.png"
        p = PROJECT / rel
        e = lic["assets"].get(rel) or {}
        e.update(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size)
        lic["assets"][rel] = e
    if "ROUND14 brows" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND14 brows: brow-line px moved into brow-l/r; the hair under them in head.png is inpainted from the neighbouring bangs.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    (L10.ROOT / "scripts/rive-complete/round14/brows-report.json").write_text(json.dumps(rep, indent=1) + "\n")
    print("ROUND14 brows", json.dumps(rep))


if __name__ == "__main__":
    main()
