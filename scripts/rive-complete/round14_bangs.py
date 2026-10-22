#!/usr/bin/env python3
"""ROUND14 item 4 — bangs: three chunks on short chain bones + a hidden forehead underlayer.

R13 kept the bangs rigid because every strand ends over forehead / brows / eyes that the mother never painted.
Here:
  * the bangs (non-skin px of the head-group crops below the hairline cut, mother y >= CUT) are split into three
    chunks: A (over the left brow) | B (left of the forehead gap) split along the darkest strand line found by a
    seam search, and C (the strands right of the gap, under the N clip); moved (not copied) out of every crop;
  * each chunk gets a 3 px skirt of its opaque neighbours (hidden at rest, closes the bilinear hairline);
  * underlayer: head.png receives, at every moved px, forehead skin synthesized by cv2 TELEA from skin-only sources
    where the px is within REVEAL px of skin (what a lifted tip can uncover), else the original hair px (deep inside a
    chunk, never uncovered at these amplitudes) -> a moved chunk reveals skin or hair, never a hole;
  * motion: per-chunk 2-link damped pendulum driven by the baked head motion (same FK as round13_hair), soft-clamped
    at CLAMP rad, plus a faint idle breeze. Amplitudes are kept small on purpose (tips move ~1-2 art px).
Brows stay in front of the bangs (they are painted over them). Runs after round14_brows.py."""
from __future__ import annotations

import hashlib
import json
import math
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
H, W, S = HR.H, HR.W, R8.S
HEAD = HR.HEAD_LOCAL
SRC = ["hair-r", "hair-l", "eye-r", "eye-l", "mouth", "head"]          # back -> front, crops that may hold bangs
CUT = 100
CHUNKS = {"a": dict(x=(444, None), y=(CUT, 160)), "b": dict(x=(None, 542), y=(CUT, 160)), "c": dict(x=(544, 572), y=(CUT, 150))}
SEAM = (474, 494)          # search window (mother x) for the A|B strand line
SKIRT, REVEAL, BAND = 3, 8, 14.0
OMEGA = {"a": 2 * math.pi * 1.9, "b": 2 * math.pi * 2.1, "c": 2 * math.pi * 2.4}
ZETA, HANG, FLARE, CLAMP, FADE, MIN_BAKE = 0.35, 0.15, 0.3, 0.03, 16, 0.002
BREEZE = {"a": ((0.004, 0.0), (0.006, -0.7)), "b": ((0.004, 0.9), (0.006, 0.2)), "c": ((0.005, 1.9), (0.007, 1.2))}


def seam(lum):
    """darkest 8-connected top->bottom path in SEAM between CUT and 160 -> {y: x}"""
    x0, x1 = SEAM
    sub = lum[CUT:160, x0:x1].astype(np.float64)
    cost = sub.copy()
    for y in range(1, cost.shape[0]):
        prev = cost[y - 1]
        best = np.minimum(prev, np.minimum(np.r_[np.inf, prev[:-1]], np.r_[prev[1:], np.inf]))
        cost[y] += best
    path = {}
    x = int(np.argmin(cost[-1]))
    for y in range(cost.shape[0] - 1, -1, -1):
        path[CUT + y] = x0 + x
        if y:
            cand = [(cost[y - 1, j], j) for j in (x - 1, x, x + 1) if 0 <= j < cost.shape[1]]
            x = min(cand)[1]
    return path


def simulate(dur, tracks, ids, piv, lens, omega, side):
    sub, dt = 4, 1.0 / (HR.FPS * 4)
    th, vel, out = None, [0.0, 0.0], []
    sgn = 1.0 if side != "c" else -1.0
    for fr in range(dur + 1):
        for k in range(sub):
            t = fr + k / sub
            (f0, r0), (f1, r1), (f2, r2) = (HR.head_fk(tracks, ids, t + d) for d in (-1 / sub, 0, 1 / sub))
            p0, p1, p2 = f0(piv), f1(piv), f2(piv)
            ax, ay = [(p2[i] - 2 * p1[i] + p0[i]) / dt ** 2 for i in (0, 1)]
            alpha = (r2 - 2 * r1 + r0) / dt ** 2
            c, s = math.cos(-r1), math.sin(-r1)
            axl, ayl = c * ax - s * ay, s * ax + c * ay
            tgt = -HANG * r1 + FLARE * max(0.0, ayl) / HR.G * sgn
            gm = min(2.0, max(0.3, 1.0 + ayl / HR.G))
            if th is None:
                th = [tgt, tgt]
            for i in range(2):
                acc = -(omega ** 2) * gm * (th[i] - tgt) - 2 * ZETA * omega * vel[i] - alpha - axl / lens[i]
                vel[i] += acc * dt
                th[i] += vel[i] * dt
        rel = [th[0], th[1] - th[0]]
        fade = R8.smooth01((dur - fr) / FADE) * R8.smooth01(fr / 4.0)
        out.append([CLAMP * math.tanh(v / CLAMP) * fade for v in rel])
    return np.array(out)


def main():
    scene = SCENE.read_text(encoding="utf-8")
    lic = json.loads(LICENSE.read_text())
    meta = json.loads(L10.META.read_text())
    boxes = meta["boxes"]
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    mother = np.array(Image.open(PROJECT / "source-nomi-master.png").convert("RGBA"))
    skin = HR.skin_mask(mother)
    cv = {n: HR.canvas(n, boxes) for n in SRC}
    orig = np.zeros((H, W, 4), np.uint8)
    for n in SRC:
        orig = HR.over(orig, cv[n])
    of = orig.astype(np.float32)
    lum = 0.3 * of[..., 0] + 0.59 * of[..., 1] + 0.11 * of[..., 2]
    path = seam(lum)
    union = orig[..., 3] > 0
    rep = {"seam_ab": [path[CUT], path[159]], "chunks": {}, "baked": {}}
    masks = {}
    yy, xx = np.mgrid[0:H, 0:W]
    sx = np.zeros((H, W), np.int32)
    for y, x in path.items():
        sx[y] = x
    for k, c in CHUNKS.items():
        m = (yy >= c["y"][0]) & (yy < c["y"][1]) & union & ~skin
        if k == "a":
            m &= (xx >= c["x"][0]) & (xx < sx)
        elif k == "b":
            m &= (xx >= sx) & (xx < c["x"][1])
        else:
            m &= (xx >= c["x"][0]) & (xx < c["x"][1])
        n_, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
        keep = np.zeros_like(m)
        for i in range(1, n_):
            if st[i, 4] >= 30:
                keep |= lab == i
        masks[k] = keep
    allm = np.zeros((H, W), bool)
    for m in masks.values():
        allm |= m
    # forehead skin synthesized from skin-only sources
    ys, xs = np.where(allm)
    bx0, bx1, by0, by1 = xs.min() - 16, xs.max() + 17, ys.min() - 16, ys.max() + 17
    sub = np.ascontiguousarray(orig[by0:by1, bx0:bx1, :3])
    src_ok = (skin & union & ~allm)[by0:by1, bx0:bx1]
    fill = cv2.inpaint(sub, (~src_ok).astype(np.uint8) * 255, 6, cv2.INPAINT_TELEA)
    fill = cv2.GaussianBlur(fill, (3, 3), 0)
    dist = cv2.distanceTransform((~src_ok).astype(np.uint8), cv2.DIST_L2, 3)
    pieces = {}
    k_ = 2 * SKIRT + 1
    for k, m in masks.items():
        comp = np.zeros((H, W, 4), np.uint8)
        contrib = {}
        for n in SRC:
            sel = m & (cv[n][..., 3] > 0)
            if sel.any():
                contrib[n] = int(sel.sum())
                comp = HR.over(comp, np.where(sel[..., None], cv[n], 0).astype(np.uint8))
        ring = cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k_, k_))) > 0
        sk = ring & ~m & (orig[..., 3] >= 250)      # face crops are ~253 opaque
        comp[sk] = orig[sk]
        ys, xs = np.where(comp[..., 3] > 0)
        bb = [int(xs.min()) - 2, int(ys.min()) - 2, int(xs.max()) + 3, int(ys.max()) + 3]
        name = f"bangs-{k}"
        Image.fromarray(comp[bb[1]:bb[3], bb[0]:bb[2]]).save(OUT / f"{name}.png")
        boxes[name] = bb
        cm = np.where(m)
        pieces[k] = (name, bb, float(cm[1][cm[0] < CUT + 4].mean()), int(cm[0].max()) + 1)
        rep["chunks"][k] = {"px": int(m.sum()), "skirt_px": int(sk.sum()), "from": contrib, "box": bb}
    # move out of the crops, then write the underlayer into head.png
    for n in SRC:
        cv[n][allm] = 0
    hb = allm[by0:by1, bx0:bx1]
    near = hb & (dist <= REVEAL)
    far = hb & ~near
    hd = cv["head"][by0:by1, bx0:bx1]
    o = orig[by0:by1, bx0:bx1]
    hd[near, :3] = fill[near]
    hd[far, :3] = o[far, :3]
    hd[hb, 3] = o[hb, 3]
    rep["underlayer"] = {"skin_px": int(near.sum()), "hair_dup_px": int(far.sum())}
    for n in SRC:
        b = boxes[n]
        a = np.array(Image.open(OUT / f"{n}.png").convert("RGBA"))
        new = cv[n][b[1]:b[1] + a.shape[0], b[0]:b[0] + a.shape[1]]
        if not np.array_equal(new, a):
            Image.fromarray(new).save(OUT / f"{n}.png")
    # ------------------------------------------------------------------ scene
    head_id = ids["full.head"]
    xml, chain = [], {}
    for k, (name, bb, pcx, ybot) in pieces.items():
        px, py = R8.art(pcx, CUT)
        lx, ly = px - HEAD[0], py - HEAD[1]
        Lm = ybot - CUT
        seg = Lm / 2 * S
        bid = [R8.nid("bone") for _ in range(2)]
        chain[k] = bid
        bn = f"full.bangs.{k}"
        b2 = R8.bone(f"{bn}.s2", 0.0, seg, bid[1])
        b1 = R8.bone(f"{bn}.s1", lx, ly, bid[0], inner=b2)
        aid = R8.nid("asset")
        scene = scene.replace('<ImageAsset name="fullbody-hair-bow"', f'<ImageAsset name="fullbody-{name}" file="reference/svg-rig/{name}.png" id="{aid}"/>\n    <ImageAsset name="fullbody-hair-bow"', 1)

        def wf(x, y, Lm=Lm):
            my = (y + HEAD[1] - R8.OY) / S
            free = R8.smooth01((my - CUT) / BAND)
            t = max(0.0, my - CUT) / max(Lm, 1)
            w2 = R8.smooth01((t - 0.35) / 0.3)
            return [1 - free, free * (1 - w2), free * w2]
        bones = [(head_id, (0.0, 0.0)), (bid[0], (lx, ly)), (bid[1], (lx, ly + seg))]
        xml.append(R8.image_mesh(f"{bn}.image", aid, bb, (5.0, 5.0), wf, bones, parent_origin=HEAD))
        xml.append(b1)
        rep["chunks"][k]["chain_len_art"] = round(Lm * S, 1)
        rep["chunks"][k]["pivot_mother"] = [round(pcx, 1), CUT]
        lic["assets"][f"reference/svg-rig/{name}.png"] = {}
    i = scene.index('<Image name="full.head.image"')
    i = scene.rfind("\n", 0, i) + 1
    scene = scene[:i] + "\n".join(xml) + "\n" + scene[i:]
    anims = A.animations(scene)
    for an, (dur, tracks) in anims.items():
        if an == "rest":
            continue
        for k, (name, bb, pcx, ybot) in pieces.items():
            if an == "full.idle":
                tr = "".join(A.linear_track(chain[k][i], "rotation",
                             [(f, amp * math.sin(2 * math.pi * f / dur * 2 + ph)) for f in range(0, dur + 1, 4)])
                             for i, (amp, ph) in enumerate(BREEZE[k]))
                scene = A.add_to_anim(scene, an, tr)
                rep["baked"].setdefault(an, {})[k] = BREEZE[k][-1][0]
                continue
            px, py = R8.art(pcx, CUT)
            piv = (px - HEAD[0], py - HEAD[1])
            La = rep["chunks"][k]["chain_len_art"]
            th = simulate(dur, tracks, ids, piv, [La / 4 + 6, La * 3 / 4], OMEGA[k], k)
            mx = float(np.abs(th).max())
            if mx < MIN_BAKE:
                continue
            frames = list(range(0, dur + 1, 2)) + ([dur] if dur % 2 else [])
            scene = A.add_to_anim(scene, an, "".join(A.linear_track(chain[k][i], "rotation", [(f, float(th[f, i])) for f in frames]) for i in range(2)))
            rep["baked"].setdefault(an, {})[k] = round(mx, 4)
    if "ROUND14 bangs" not in scene:
        scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n", "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND14 bangs: three chunks on short chains -->\n", 1)
    SCENE.write_text(scene, encoding="utf-8")
    txt = L10.META.read_text()
    for k in pieces:
        key = f"bangs-{k}"
        if f'"{key}"' not in txt:
            txt = re.sub(r'(\n\s*)("hair-bow": )', lambda m_: f'{m_.group(1)}"{key}": {boxes[key]},{m_.group(1)}{m_.group(2)}', txt, count=1)
    json.loads(txt)
    L10.META.write_text(txt)
    for n in SRC + [f"bangs-{k}" for k in pieces]:
        rel = f"reference/svg-rig/{n}.png"
        p = PROJECT / rel
        e = lic["assets"].get(rel) or {}
        e.update(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size, ai_generated=False, in_scene=True,
                 method=e.get("method", "deterministic source-pixel rig layer derived from user supplied full-body mother"))
        lic["assets"][rel] = e
    if "ROUND14 bangs" not in lic.get("note", ""):
        lic["note"] = (lic.get("note", "") + " ROUND14 bangs: bang px moved into bangs-{a,b,c}; the forehead under them in head.png is inpainted from neighbouring skin (hair px kept where never uncovered).").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    (L10.ROOT / "scripts/rive-complete/round14/bangs-report.json").write_text(json.dumps(rep, indent=1) + "\n")
    print("ROUND14 bangs", json.dumps(rep["chunks"]), rep["underlayer"], "baked:", len(rep["baked"]))


if __name__ == "__main__":
    main()
