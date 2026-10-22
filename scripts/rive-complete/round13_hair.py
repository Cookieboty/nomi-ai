#!/usr/bin/env python3
"""ROUND13 item 2 — hair: the two side locks become their own skinned layers with chain bones + baked follow-through.

What the mother art allows (REPORT-ROUND13.md):
  * side locks (screen-left: below the temple, outside the cheek; screen-right: incl. the orange ribbon bow) hang free
    -> own layer, 3-bone chain, weights anchored to the head along the top cut and along the cheek/ear edge so the
    hair that overlaps the face never moves (the mother has no cheek pixels under it).
  * bangs: every strand ends over forehead / brows / eyes; moving them would uncover skin that the mother never
    painted -> stay rigid with the head (honest limit).  Back hair: only ~170 px peek out beside the neck -> rigid.
Ownership: the lock pixels are *moved* (not copied) out of every head-group crop that held them (head, hair-l/r,
hair-bow, hair-clip, eyes, brows ...), composited back-to-front in the scene's draw order, so the rest pose is
pixel-identical and nothing is drawn twice; only a 2 px skirt across the top cut overlaps the head hair (hidden at rest,
closes the cut when the lock bends).
Motion: idle sway + per-clip damped pendulum per link in the head frame, driven by the baked head motion
(pose -> torso -> neck -> head FK: pivot acceleration, head angular acceleration, gravity share, vertical bounce).
Runs after round13_hem.py."""
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
import round10_layers as L10

PROJECT, OUT = L10.PROJECT, L10.OUT
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
S = R8.S
H, W = 1536, 1024
# head group crops, BACK to FRONT (scene draw order: earlier child = in front)
LAYERS = ["hair-back-r", "hair-back-l", "hair-r", "hair-l", "eye-r", "eye-l", "mouth", "brow-r", "brow-l", "head", "hair-clip", "hair-bow"]
IMAGE_OF = {"hair-back-r": "full.hair.back.r.image", "hair-back-l": "full.hair.back.l.image", "hair-r": "full.hair.r.image",
            "hair-l": "full.hair.l.image", "eye-r": "full.eye.r.image", "eye-l": "full.eye.l.image", "mouth": "full.mouth.image",
            "brow-r": "full.brow.r.image", "brow-l": "full.brow.l.image", "head": "full.head.image",
            "hair-clip": "full.hair.clip.image", "hair-bow": "full.hair.bow.image"}
# lock regions (mother px): x range, y range; CUT = top cut row, EDGE = cheek/ear edge column (weights anchored there)
REG = {"l": dict(x=(320, 444), y=(100, 262), cut=100, edge=444, pivot=(428, 104)),
       "r": dict(x=(572, 720), y=(108, 262), cut=108, edge=572, pivot=(586, 112))}
SKIRT = 2
HEAD_LOCAL = (480.0, 253.9)      # full.head world position at rest (torso 480,660 + neck 0,-406.1)
FPS, G = 60.0, 7840.0
OMEGA = 2 * math.pi * 1.6        # rad/s natural frequency of the lock (stiff, short hair)
ZETA = 0.30
HANG = 0.25                      # share of the head tilt the lock cancels (hangs toward gravity)
FLARE = 0.6
CLAMP = 0.06
FADE = 16
MIN_BAKE = 0.002
BREEZE = ((0.010, 0.0), (0.012, -0.8), (0.014, -1.6))
BAND = 14.0                      # mother px: anchor blend width at the cut / the cheek edge


def skin_mask(rgba):
    r, g, b, a = [rgba[..., i].astype(int) for i in range(4)]
    return (a > 0) & (r > 200) & (g > 150) & (b > 140) & (r - b < 90)


def canvas(name, boxes):
    a = np.array(Image.open(OUT / f"{name}.png").convert("RGBA"))
    full = np.zeros((H, W, 4), np.uint8)
    b = boxes[name]
    full[b[1]:b[1] + a.shape[0], b[0]:b[0] + a.shape[1]] = a
    return full


def over(dst, src):
    """premultiplied-correct 'src over dst' for uint8 straight-alpha RGBA arrays"""
    sa = src[..., 3:4] / 255.0
    da = dst[..., 3:4] / 255.0
    oa = sa + da * (1 - sa)
    rgb = (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6)
    return np.concatenate([np.clip(rgb + 0.5, 0, 255), np.clip(oa * 255 + 0.5, 0, 255)], -1).astype(np.uint8)


def head_fk(tracks, ids, f):
    """world transform of the head frame at frame f -> (fn(local)->world, world rotation)"""
    pose_fn, pr = A.pose_xform(tracks, ids["full.pose"], f)
    rot = lambda nm: (A.eval_track(tracks.get(ids[nm], {}).get("rotation"), f) or 0.0) if tracks.get(ids[nm], {}).get("rotation") else 0.0
    rt, rn, rh = rot("full.torso"), rot("full.neck"), rot("full.head")
    def fn(p):
        x, y = p
        c, s = math.cos(rh + rn), math.sin(rh + rn)            # head at neck origin; neck at (0,-406.1) in torso
        x, y = c * x - s * y, s * x + c * y
        y -= 406.1
        c, s = math.cos(rt), math.sin(rt)
        x, y = c * x - s * y + 480.0, s * x + c * y + 660.0
        return pose_fn((x, y))
    return fn, pr + rt + rn + rh


def simulate(dur, tracks, ids, piv_local, lens, side):
    sub, dt = 4, 1.0 / (FPS * 4)
    th, vel, out = None, [0.0] * 3, []
    sgn = 1.0 if side == "l" else -1.0
    for fr in range(dur + 1):
        for k in range(sub):
            t = fr + k / sub
            (f0, r0), (f1, r1), (f2, r2) = head_fk(tracks, ids, t - 1 / sub), head_fk(tracks, ids, t), head_fk(tracks, ids, t + 1 / sub)
            p0, p1, p2 = f0(piv_local), f1(piv_local), f2(piv_local)
            ax, ay = [(p2[i] - 2 * p1[i] + p0[i]) / dt ** 2 for i in (0, 1)]
            alpha = (r2 - 2 * r1 + r0) / dt ** 2
            # pivot acceleration in the head frame
            c, s = math.cos(-r1), math.sin(-r1)
            axl, ayl = c * ax - s * ay, s * ax + c * ay
            tgt = -HANG * r1 + FLARE * max(0.0, ayl) / G * sgn
            gm = min(2.0, max(0.3, 1.0 + ayl / G))
            if th is None:
                th = [tgt] * 3
            for i in range(3):
                acc = -(OMEGA ** 2) * gm * (th[i] - tgt) - 2 * ZETA * OMEGA * vel[i] - alpha - axl / lens[i]
                vel[i] += acc * dt
                th[i] += vel[i] * dt
        rel = [th[0], th[1] - th[0], th[2] - th[1]]
        fade = R8.smooth01((dur - fr) / FADE) * R8.smooth01(fr / 4.0)
        # soft clamp (tanh): no flat-topped plateaus / velocity kinks at the limit
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
    hair = ~skin_mask(mother)
    cv = {n: canvas(n, boxes) for n in LAYERS}
    union = np.zeros((H, W), bool)
    for n in LAYERS:
        union |= cv[n][..., 3] > 0
    report = {"pieces": {}, "baked": {}}
    pieces = {}
    for side, rg in REG.items():
        m = np.zeros((H, W), bool)
        m[rg["y"][0]:rg["y"][1], rg["x"][0]:rg["x"][1]] = True
        m &= hair & union
        # drop specks not connected to the lock body
        n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
        keep = np.zeros_like(m)
        for i in range(1, n):
            if st[i, 4] >= 30:
                keep |= lab == i
        m = keep
        comp = np.zeros((H, W, 4), np.uint8)
        contrib = {}
        for nme in LAYERS:
            sel = m & (cv[nme][..., 3] > 0)
            if sel.any():
                contrib[nme] = int(sel.sum())
                layer = np.where(sel[..., None], cv[nme], 0).astype(np.uint8)
                comp = over(comp, layer)
                cv[nme][sel] = 0
        # skirt: opaque pixels of the remaining layers within SKIRT px of the lock (copied, still owned by their layer).
        # The artboard samples the crops at 0.846 px/texel, so a pure ownership cut fades on both sides (bilinear) and
        # shows a hairline; the front-drawn lock carries the opaque neighbours across the cut instead (identical at rest).
        rest = np.zeros((H, W, 4), np.uint8)
        for nme in LAYERS:
            rest = over(rest, cv[nme])
        k = 2 * SKIRT + 1
        ring = cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0
        sk = ring & ~m & (rest[..., 3] == 255) & (comp[..., 3] == 0)
        comp[sk] = rest[sk]
        ys, xs = np.where(comp[..., 3] > 0)
        bb = [int(xs.min()) - 2, int(ys.min()) - 2, int(xs.max()) + 3, int(ys.max()) + 3]
        crop = comp[bb[1]:bb[3], bb[0]:bb[2]]
        name = f"hair-lock-{side}"
        Image.fromarray(crop).save(OUT / f"{name}.png")
        boxes[name] = bb
        pieces[side] = (name, bb, crop)
        report["pieces"][side] = {"px": int(m.sum()), "skirt_px": int(sk.sum()), "from": contrib, "box": bb}
    # write back the trimmed head-group crops
    for nme in LAYERS:
        b = boxes[nme]
        a = np.array(Image.open(OUT / f"{nme}.png").convert("RGBA"))
        new = cv[nme][b[1]:b[1] + a.shape[0], b[0]:b[0] + a.shape[1]]
        if not np.array_equal(new, a):
            Image.fromarray(new).save(OUT / f"{nme}.png")
    # ------------------------------------------------------------------ scene: bones + skinned images under full.head
    head_id = ids["full.head"]
    xml_imgs, xml_bones, chain = [], [], {}
    for side, (name, bb, crop) in pieces.items():
        rg = REG[side]
        px, py = R8.art(*rg["pivot"])
        lx, ly = px - HEAD_LOCAL[0], py - HEAD_LOCAL[1]
        y_bot = bb[3]
        Lm = (y_bot - rg["cut"])                       # mother px
        seg = [Lm / 3 * S, Lm / 3 * S]
        bid = [R8.nid("bone") for _ in range(3)]
        chain[side] = bid
        bn = f"full.hair.lock.{side}"
        b3 = R8.bone(f"{bn}.s3", 0.0, seg[1], bid[2])
        b2 = R8.bone(f"{bn}.s2", 0.0, seg[0], bid[1], inner=b3)
        b1 = R8.bone(f"{bn}.s1", lx, ly, bid[0], inner=b2)
        xml_bones.append(b1)
        aid = R8.nid("asset")
        scene = scene.replace('<ImageAsset name="fullbody-hair-bow"', f'<ImageAsset name="fullbody-{name}" file="reference/svg-rig/{name}.png" id="{aid}"/>\n    <ImageAsset name="fullbody-hair-bow"', 1)
        sgn = 1.0 if side == "l" else -1.0
        def wf(x, y, rg=rg, sgn=sgn):
            mx, my = (x + HEAD_LOCAL[0] - R8.OX) / S, (y + HEAD_LOCAL[1] - R8.OY) / S      # back to mother px
            d_cut = my - rg["cut"]
            d_edge = (rg["edge"] - mx) * sgn
            free = R8.smooth01(d_cut / BAND) * R8.smooth01(d_edge / BAND)
            t = max(0.0, d_cut) / max(Lm, 1)
            sm = R8.smooth01
            w1 = 1 - sm((t - 0.24) / 0.18)
            w3 = sm((t - 0.58) / 0.18)
            w2 = max(0.0, 1 - w1 - w3)
            return [1 - free, free * w1, free * w2, free * w3]
        bones = [(head_id, (0.0, 0.0)), (bid[0], (lx, ly)), (bid[1], (lx, ly + seg[0])), (bid[2], (lx, ly + seg[0] + seg[1]))]
        xml_imgs.append(R8.image_mesh(f"full.hair.lock.{side}.image", aid, bb, (6.0, 6.0), wf, bones, parent_origin=HEAD_LOCAL))
        report["pieces"][side]["chain_len_art"] = round(Lm * S, 1)
        lic["assets"][f"reference/svg-rig/{name}.png"] = {}
    # insert: bones + images as the first children of full.head (front of the head group, like the old hair bow)
    a, _ = R8.find_elem(scene, "RootBone", "full.head")
    tag_end = scene.index(">", a) + 1
    scene = scene[:tag_end] + "\n" + "\n".join(xml_imgs + xml_bones) + scene[tag_end:]
    # ------------------------------------------------------------------ motion
    anims = A.animations(scene)
    for an, (dur, tracks) in anims.items():
        if an == "rest":
            continue
        for side in "lr":
            rg = REG[side]
            px, py = R8.art(*rg["pivot"])
            piv = (px - HEAD_LOCAL[0], py - HEAD_LOCAL[1])
            Lart = report["pieces"][side]["chain_len_art"]
            lens = [Lart / 6 + 8, Lart / 2, Lart * 5 / 6]
            if an == "full.idle":
                sg = 1.0 if side == "l" else -1.0
                xml = "".join(A.linear_track(chain[side][i], "rotation",
                              [(f, sg * amp * math.sin(2 * math.pi * f / dur * 2 + ph + (0 if side == "l" else 1.1))) for f in range(0, dur + 1, 4)])
                              for i, (amp, ph) in enumerate(BREEZE))
                scene = A.add_to_anim(scene, an, xml)
                report["baked"].setdefault(an, {})[side] = BREEZE[-1][0]
                continue
            th = simulate(dur, tracks, ids, piv, lens, side)
            mx = float(np.abs(th).max())
            if mx < MIN_BAKE:
                continue
            frames = list(range(0, dur + 1, 2)) + ([dur] if dur % 2 else [])
            scene = A.add_to_anim(scene, an, "".join(A.linear_track(chain[side][i], "rotation", [(f, float(th[f, i])) for f in frames]) for i in range(3)))
            report["baked"].setdefault(an, {})[side] = round(mx, 4)
    if "ROUND13 hair" not in scene:
        scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n", "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND13 hair: side locks on their own skinned chains -->\n", 1)
    SCENE.write_text(scene, encoding="utf-8")
    # rig-meta boxes (textual insert after "hair-bow")
    txt = L10.META.read_text()
    for side in "lr":
        k = f"hair-lock-{side}"
        if f'"{k}"' not in txt:
            txt = re.sub(r'(\n\s*)("hair-bow": )', lambda m_: f'{m_.group(1)}"{k}": {boxes[k]},{m_.group(1)}{m_.group(2)}', txt, count=1)
    json.loads(txt)
    L10.META.write_text(txt)
    # license: refresh every touched head-group crop + the new locks
    for nme in LAYERS + ["hair-lock-l", "hair-lock-r"]:
        rel = f"reference/svg-rig/{nme}.png"
        p = PROJECT / rel
        e = lic["assets"].get(rel) or {}
        e.update(sha256=hashlib.sha256(p.read_bytes()).hexdigest(), bytes=p.stat().st_size, ai_generated=False, in_scene=True,
                 method=e.get("method", "deterministic source-pixel rig layer derived from user supplied full-body mother"))
        lic["assets"][rel] = e
    note = lic.get("note", "")
    if "ROUND13 hair" not in note:
        lic["note"] = (note + " ROUND13 hair: side-lock pixels moved (not copied) out of the head-group crops into hair-lock-{l,r}.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    (L10.ROOT / "scripts/rive-complete/round13/hair-report.json").write_text(json.dumps(report, indent=1) + "\n")
    print("ROUND13 hair", json.dumps(report["pieces"]), "baked:", len(report["baked"]))


if __name__ == "__main__":
    main()
