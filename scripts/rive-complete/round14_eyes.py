#!/usr/bin/env python3
"""ROUND14 item 1+2 — eyes as per-part layers + a real blink (eyes close, head untouched).

Root cause (REPORT-ROUND14.md): the R7 "eye-l/r" crops were rectangles that actually held cheek/jaw-side pieces and the
"brow-l/r" crops held the outer upper-lash corners; the eyes themselves were painted inside head.png (in front of all
of them). full.blink therefore had nothing to close and keyed full.head scaleY 1 -> 0.08 (whole head squashed).
Fix:
  * per eye, the eye opening (non-skin pixels in an ellipse around the eye, convex-filled) is cut out of every head-group
    crop (composited back-to-front once, so the rest pose is unchanged and nothing is drawn twice) and split into
    upper lash (top 5 px of the opening + dark corner lashes), lower lid line (bottom 2 px), iris (+pupil) inside the
    iris circle, highlight (light px in the iris circle) and sclera (the rest);
  * a hidden eyelid-skin underlayer (the opening dilated 2 px) is synthesized from the neighbouring mother skin
    (cv2 TELEA inpaint with all non-skin px masked out, light blur) - it only shows while the eye is closed;
  * bones under full.head: full.eye2.<s> (lid line), .ball (iris/highlight/sclera, scales to the lid line),
    .lash (slides down onto the lid line);
  * full.blink: head scaleY keys removed; ball scaleY 1 -> 0.06, lash down to the lid line (scaleY 0.6).
Runs after round13_collar.py."""
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
EYE = {"l": dict(c=(465, 163), r=(20, 14), split=160, iris=(468, 165, 10)),
       "r": dict(c=(543, 158), r=(21, 14), split=154, iris=(539, 159, 11))}
PARTS = ("lash", "lid", "hl", "iris", "sclera", "skin")          # front -> back inside the eye group
BLINK = [(0, 0.0), (7, 1.0), (12, 1.0), (22, 0.0)]                # closure 0..1
KNOWN_DIST = 3.0
HAIR_SHADE = 0.06
CREASE = 0.07                                                      # ROUND16: crease darkening
MOTHER = np.array(Image.open(PROJECT / "source-nomi-master.png").convert("RGB"))
_mc = MOTHER.astype(int)
MSKIN = (_mc[..., 0] > 200) & (_mc[..., 1] > 150) & (_mc[..., 2] > 140) & (_mc[..., 0] - _mc[..., 2] < 90) & (_mc[..., 0] - _mc[..., 2] >= 22)


def skin_all(rgb):
    c = rgb.astype(int)
    return (c[..., 0] > 200) & (c[..., 1] > 150) & (c[..., 2] > 140) & (c[..., 0] - c[..., 2] < 90) & (c[..., 0] - c[..., 2] >= 22)


def lid_fill(mom, m, skin, top, bot):
    """mom: mother RGB crop, m: eye opening, skin: mother skin mask.  Pixels outside the opening keep the mother pixel
    (they are hidden under head.png anyway and make the edge seamless); inside, a harmonic interpolation with the mother
    skin px as Dirichlet values and non-skin px (hair / lashes / outline) as Neumann (free) boundaries."""
    f = mom.astype(np.float64)
    # the 1-2 px next to the opening are outline anti-aliasing (tinted by the lashes): solve them too, sample from >= 3 px
    dist = cv2.distanceTransform((~m).astype(np.uint8), cv2.DIST_L2, 3)
    # and skin px touching hair / lashes are anti-aliased with them (darker, desaturated): sample clean skin only
    clean = cv2.erode(skin.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) > 0
    skin = clean & (dist >= KNOWN_DIST)
    free = m | ~skin                        # solved px; known = mother skin >= KNOWN_DIST px outside the opening
    u = f.copy()
    # start from the mean boundary skin colour
    ring = (cv2.dilate(m.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0) & ~m & skin
    u[free] = f[ring].mean(0)
    dom = free.copy()
    dom[0, :] = dom[-1, :] = dom[:, 0] = dom[:, -1] = False
    nb = [(0, 1), (0, -1), (1, 0), (-1, 0)]
    for _ in range(4000):
        acc = np.zeros_like(u)
        cnt = np.zeros(u.shape[:2])
        for dy, dx in nb:
            sh = np.roll(np.roll(u, dy, 0), dx, 1)
            ok = np.roll(np.roll((skin & ~m) | dom, dy, 0), dx, 1)   # known skin or solved px; crop border = Neumann
            acc += np.where(ok[..., None], sh, 0)
            cnt += ok
        new = acc / np.maximum(cnt, 1)[..., None]
        u[dom] = new[dom]
    # crease: faint darker arc ~40 % of the way from the lid line up to the opening top, tapered at the corners
    h, w = m.shape
    yy = np.arange(h)[:, None].astype(np.float64)
    cols = np.where(m.any(0))[0]
    cr = np.ones((h, w))
    if len(cols) > 4:
        c0, c1 = cols.min(), cols.max()
        for x in cols:
            if bot[x] < 0 or top[x] > h:
                continue
            yc = bot[x] - 0.42 * (bot[x] - top[x])
            t = (x - c0) / max(1, c1 - c0)
            taper = np.clip(np.sin(np.pi * t) * 1.4, 0, 1)
            cr[:, x] = 1.0 - CREASE * taper * np.exp(-0.5 * ((yy[:, 0] - yc) / 0.9) ** 2)
    u = u * cr[..., None]
    # bangs / side-hair shadow: px of the opening near mother hair darken a little toward it (soft contact shadow)
    lum0 = 0.3 * f[..., 0] + 0.59 * f[..., 1] + 0.11 * f[..., 2]
    hair = ~skin_all(mom) & (lum0 < 205) & ~m
    dh = cv2.distanceTransform((~hair).astype(np.uint8), cv2.DIST_L2, 3)
    u = u * (1.0 - HAIR_SHADE * np.exp(-dh / 2.5))[..., None]
    out = np.where(m[..., None], u, f)
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


def r14_fill(comp, skin, m, tgt, ys, e, box):
    """ROUND14 eyelid fill (TELEA from skin + boundary offset + top shade), kept for the ring outside the opening."""
    x0, x1, y0, y1 = box
    reg = np.zeros((H, W), bool)
    reg[y0:y1, x0:x1] = True
    hole = tgt | (reg & ~skin)
    sub = np.ascontiguousarray(comp[y0:y1, x0:x1, :3])
    fill = cv2.GaussianBlur(cv2.inpaint(sub, hole[y0:y1, x0:x1].astype(np.uint8) * 255, 6, cv2.INPAINT_TELEA), (5, 5), 0)
    tg = tgt[y0:y1, x0:x1]
    edge = (cv2.dilate(tg.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & ~tg & skin[y0:y1, x0:x1]
    off = np.zeros(sub.shape, np.float32)
    off[edge] = sub[edge].astype(np.float32) - fill[edge].astype(np.float32)
    known = edge.astype(np.uint8)
    offi = np.zeros(sub.shape, np.float32)
    for ch in range(3):
        o8 = np.clip(off[..., ch] + 128.0, 0, 255).astype(np.uint8)
        offi[..., ch] = cv2.inpaint(o8, (1 - known) * 255, 8, cv2.INPAINT_TELEA).astype(np.float32) - 128.0
    offi = cv2.GaussianBlur(offi, (7, 7), 0)
    fill = np.clip(fill.astype(np.float32) + offi, 0, 255).astype(np.uint8)
    yy0, yy1 = float(ys.min()), float(e["c"][1])
    rows = np.arange(y0, y1, dtype=np.float32)[:, None, None]
    shade = 0.90 + 0.10 * np.clip((rows - yy0) / max(1.0, yy1 - yy0), 0, 1)
    return np.clip(fill.astype(np.float32) * shade, 0, 255).astype(np.uint8)


def segment(comp):
    c = comp.astype(int)
    R, G, B, Al = (c[..., i] for i in range(4))
    lum = 0.3 * R + 0.59 * G + 0.11 * B
    skin = (R > 200) & (G > 150) & (B > 140) & (R - B < 90) & (R - B >= 22)
    yy, xx = np.mgrid[0:H, 0:W]
    res = {}
    for s, e in EYE.items():
        (cx, cy), (rx, ry) = e["c"], e["r"]
        roi = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1
        m = roi & ~skin & (Al > 0)
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))) > 0
        n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        m = lab == 1 + int(np.argmax(st[1:, 4]))
        pad = np.pad(~m, 1, constant_values=True).astype(np.uint8)
        cv2.floodFill(pad, None, (0, 0), 2)
        m |= pad[1:-1, 1:-1] == 1
        hull = cv2.convexHull(np.column_stack(np.where(m)[::-1]).astype(np.int32))
        hm = np.zeros((H, W), np.uint8)
        cv2.fillConvexPoly(hm, hull, 1)
        m |= (hm > 0) & (lum < 250) & roi
        # anti-aliased contour px that the skin test kept (darker than the lid skin) belong to the eye outline
        ring = (cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) & ~m & (lum < 215) & (Al > 0)
        m |= ring
        top = np.full(W, 10 ** 6)
        bot = np.full(W, -1)
        ys, xs = np.where(m)
        for x in np.unique(xs):
            col = ys[xs == x]
            top[x], bot[x] = col.min(), col.max()
        ix, iy, ir = e["iris"]
        inc = (xx - ix) ** 2 + (yy - iy) ** 2 <= ir * ir
        dark, light = lum < 95, (lum > 190) & ((R - B) < 40)
        lash = m & ((yy <= top[xx] + 5) | (dark & ~inc & (yy <= e["split"])))
        lid = m & (yy >= bot[xx] - 1) & ~lash
        rest = m & ~lash & ~lid
        hl = rest & inc & light
        res[s] = dict(mask=m, lash=lash, lid=lid, hl=hl, iris=rest & inc & ~hl, sclera=rest & ~inc,
                      lid_y=float(bot[int(round(xs.mean()))]), cx=float(xs.mean()),
                      lash_y=float(np.where(lash)[0].mean()))
        # hidden eyelid skin (ROUND16): membrane (Laplace) fill of the eye opening from the MOTHER skin around it, so the
        # closed lid continues the neighbours' mean and gradient (incl. the darker skin in the bangs' shadow) with no seam;
        # + a faint crease arc above the lash line so it reads as a closed eye, not a blank patch.
        x0, x1, y0, y1 = xs.min() - 14, xs.max() + 15, ys.min() - 10, ys.max() + 14
        tgt = cv2.dilate(m.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        fill = lid_fill(MOTHER[y0:y1, x0:x1], m[y0:y1, x0:x1], MSKIN[y0:y1, x0:x1], top[x0:x1] - y0, bot[x0:x1] - y0)
        # the 2 px ring outside the opening shows at rest through the parts' anti-aliased edges: keep it exactly as R14
        # built it, so the rest pose does not change at all; only the opening (seen when closed) is re-shaded
        r14 = r14_fill(comp, skin, m, tgt, ys, e, (x0, x1, y0, y1))
        mo = m[y0:y1, x0:x1]
        fill = np.where(mo[..., None], fill, r14)
        sk = np.zeros((H, W, 4), np.uint8)
        t = tgt[y0:y1, x0:x1]
        sk[y0:y1, x0:x1][t] = np.concatenate([fill[t], np.full((int(t.sum()), 1), 255, np.uint8)], 1)
        res[s]["skin_rgba"] = sk
        res[s]["out_ring"] = tgt & ~m
        res[s]["skin"] = tgt
    return res


def main():
    scene = SCENE.read_text(encoding="utf-8")
    lic = json.loads(LICENSE.read_text())
    boxes = json.loads(L10.META.read_text())["boxes"]
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    cv = {n: HR.canvas(n, boxes) for n in HR.LAYERS}
    comp = np.zeros((H, W, 4), np.uint8)
    for n in HR.LAYERS:
        comp = HR.over(comp, cv[n])
    seg = segment(comp)
    rep = {"eyes": {}}
    groups, new_png = [], []
    for s, d in seg.items():
        moved = {}
        for n in HR.LAYERS:
            sel = d["mask"] & (cv[n][..., 3] > 0)
            if sel.any():
                moved[n] = int(sel.sum())
                cv[n][sel] = 0
        lid_x, lid_y = R8.art(d["cx"], d["lid_y"] + 0.5)
        gx, gy = lid_x - HEAD[0], lid_y - HEAD[1]
        lash_dy = (d["lash_y"] - d["lid_y"]) * R8.S
        imgs, pbox = {}, {}
        for p in PARTS:
            # skirt: back parts carry 2 px of their front neighbours / the surrounding head px (copied, hidden at rest)
            # so no part edge fades over the eyelid skin -> no hairline ring at rest
            k5 = np.ones((5, 5), np.uint8)
            if p in ("sclera", "iris"):
                front = d["lash"] | d["lid"] | d["out_ring"] | d["hl"] | (d["iris"] if p == "sclera" else False)
                sel = d[p] | ((cv2.dilate(d[p].astype(np.uint8), k5) > 0) & front)
            elif p in ("lash", "lid"):
                sel = d[p] | ((cv2.dilate(d[p].astype(np.uint8), k5) > 0) & d["out_ring"])
            else:
                sel = d.get(p)
            rgba = d["skin_rgba"] if p == "skin" else np.where(sel[..., None], comp, 0).astype(np.uint8)
            ys, xs = np.where(rgba[..., 3] > 0)
            bb = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
            name = f"eye-{s}-{p}"
            Image.fromarray(rgba[bb[1]:bb[3], bb[0]:bb[2]]).save(OUT / f"{name}.png")
            boxes[name] = bb
            pbox[p] = bb
            new_png.append(name)
            aid = R8.nid("asset")
            scene = scene.replace('<ImageAsset name="fullbody-hair-bow"',
                                  f'<ImageAsset name="fullbody-{name}" file="reference/svg-rig/{name}.png" id="{aid}"/>\n    <ImageAsset name="fullbody-hair-bow"', 1)
            imgs[p] = (aid, bb)
        pre = f"full.eye2.{s}"
        gid, bid, lid_ = R8.nid("bone"), R8.nid("bone"), R8.nid("bone")
        g_abs = (lid_x, lid_y)
        l_abs = (lid_x, lid_y + lash_dy)
        ri = lambda p, par: R8.image_rigid(f"{pre}.{p}.image", imgs[p][0], imgs[p][1], par)  # noqa: E731
        lash_b = R8.bone(f"{pre}.lash", 0.0, lash_dy, lid_, ri("lash", l_abs))
        ball_b = R8.bone(f"{pre}.ball", 0.0, 0.0, bid, ri("hl", g_abs) + ri("iris", g_abs) + ri("sclera", g_abs))
        grp = R8.bone(pre, gx, gy, gid, lash_b + ri("lid", g_abs) + ball_b + ri("skin", g_abs))
        groups.append(grp)
        rep["eyes"][s] = {"moved_from": moved, "px": {p: int(d[p].sum()) for p in PARTS if p != "skin"},
                          "skin_px": int(d["skin"].sum()), "lid_line_mother": [round(d["cx"], 1), d["lid_y"]],
                          "lash_drop_art": round(-lash_dy, 2), "ids": {"group": gid, "ball": bid, "lash": lid_}}
    # hidden duplicates: px of the rigid head-group crops drawn behind an opaque, rigid front layer (head.png above the
    # jaw blend, y < 215, or the opaque eyelid skin) can never be seen -> drop them (no change at rest or in motion)
    front = np.zeros((H, W), bool)
    front[:215] = cv["head"][:215, :, 3] == 255
    for s_ in seg:
        front |= seg[s_]["skin_rgba"][..., 3] == 255
    front = cv2.erode(front.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0     # bilinear sampling bleeds 1-2 px
    dedup = {}
    for n in ("eye-l", "eye-r", "brow-l", "brow-r", "hair-l", "hair-r", "hair-back-l", "hair-back-r"):
        sel = front & (cv[n][..., 3] > 0)
        sel[215:] = False
        if sel.any():
            dedup[n] = int(sel.sum())
            cv[n][sel] = 0
    rep["hidden_duplicates_removed"] = dedup
    # write trimmed layers
    for n in HR.LAYERS:
        b = boxes[n]
        a = np.array(Image.open(OUT / f"{n}.png").convert("RGBA"))
        new = cv[n][b[1]:b[1] + a.shape[0], b[0]:b[0] + a.shape[1]]
        if not np.array_equal(new, a):
            Image.fromarray(new).save(OUT / f"{n}.png")
            new_png.append(n)
    # eye groups right behind head.image (head was the owner there)
    m = re.search(r'<Image name="full\.head\.image".*?</Image>', scene, re.S)
    scene = scene[:m.end()] + "\n" + "\n".join(groups) + scene[m.end():]
    # blink: drop the head squash, close the eyes
    a, b = R8.find_elem(scene, "LinearAnimation", "full.blink")
    blk = re.sub(rf'<KeyedObject objectId="{ids["full.head"]}">.*?</KeyedObject>', "", scene[a:b], flags=re.S)
    keys = ""
    for s in "lr":
        e = rep["eyes"][s]
        drop = e["lash_drop_art"]
        keys += R8.keyed(e["ids"]["ball"], "scaleY", [(f, 1.0 - 0.94 * c) for f, c in BLINK])
        keys += R8.keyed(e["ids"]["lash"], "y", [(f, -drop + drop * 0.92 * c) for f, c in BLINK])
        keys += R8.keyed(e["ids"]["lash"], "scaleY", [(f, 1.0 - 0.4 * c) for f, c in BLINK])
    close = blk.rfind("</LinearAnimation>")
    blk = blk[:close] + keys + "\n" + blk[close:]
    scene = scene[:a] + blk + scene[b:]
    if "ROUND14 eyes" not in scene:
        scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n", "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND14 eyes: per-part eye layers, eyelid blink -->\n", 1)
    SCENE.write_text(scene, encoding="utf-8")
    txt = L10.META.read_text()
    for n in new_png:
        if n.startswith("eye-") and n.count("-") == 2 and f'"{n}"' not in txt:
            txt = re.sub(r'(\n\s*)("hair-bow": )', lambda q: f'{q.group(1)}"{n}": {boxes[n]},{q.group(1)}{q.group(2)}', txt, count=1)
    json.loads(txt)
    L10.META.write_text(txt)
    for n in new_png:
        rel = f"reference/svg-rig/{n}.png"
        pth = PROJECT / rel
        e = lic["assets"].get(rel) or {}
        meth = ("eyelid skin underlayer synthesized from neighbouring mother skin pixels (ROUND16: membrane fill from clean mother skin + soft hair contact shade + faint crease; ring outside the opening = R14 TELEA fill), hidden at rest"
                if n.endswith("-skin") else e.get("method", "deterministic source-pixel rig layer derived from user supplied full-body mother"))
        e.update(sha256=hashlib.sha256(pth.read_bytes()).hexdigest(), bytes=pth.stat().st_size, ai_generated=False, in_scene=True, method=meth)
        lic["assets"][rel] = e
    if "ROUND14 eyes" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND14 eyes: eye pixels moved (not copied) into per-part eye layers; eyelid skin inpainted from neighbouring skin.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    (L10.ROOT / "scripts/rive-complete/round14").mkdir(exist_ok=True)
    (L10.ROOT / "scripts/rive-complete/round14/eyes-report.json").write_text(json.dumps(rep, indent=1) + "\n")
    print("ROUND14 eyes", json.dumps({s: {k: v for k, v in e.items() if k != "ids"} for s, e in rep["eyes"].items()}), "dedup", json.dumps(dedup))


if __name__ == "__main__":
    main()
