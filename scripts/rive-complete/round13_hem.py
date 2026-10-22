#!/usr/bin/env python3
"""ROUND13 item 1 — hem (衣摆): orange hem ribbons become skinned chains with baked secondary motion; the invisible
coat-tail duplicates are removed.

Findings (REPORT-ROUND13.md):
  * ``coat-{l,r}-tail`` (1644 / 1173 px) lie completely under shorts / belt-id / belt-pouch: hiding them changes 0 px in
    every tested clip -> pure overdraw, removed (image, asset, png, license entry).
  * ``hem-ribbon-{l,r}`` were rigid Images on a bone in the middle of the ribbon -> no sway, no reaction to the body.
    Now: one skinned grid Mesh per ribbon, 4 tendons: anchor (= old ``full.hem.ribbon.<side>`` bone, moved to the top
    of the visible ribbon, i.e. the hip flap it hangs from) + a 3-bone chain s1/s2/s3 down the ribbon's centre line.
    Weights are smoothstep blends along the ribbon, so it bends but cannot tear.
  * motion: idle -> a slow travelling-wave breeze on s1..s3 (period = idle loop, 216 f); every other clip -> a damped
    pendulum simulation per link driven by the baked body motion (full.pose translation/rotation/scale -> anchor
    acceleration, gravity modulation by vertical acceleration) + the thigh pushing the ribbon outward (hop),
    baked as linear keys every 2 frames, faded to 0 over the last frames.  Clips whose result stays < 0.003 rad get no keys.
Runs after round10_build.sh (idempotent on that output)."""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys

import numpy as np
from PIL import Image

import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT, OUT = L10.PROJECT, L10.OUT
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
S = R8.S
COAT = {"l": (350.0, 560.0), "r": (610.0, 560.0)}      # full.coat-<side> world position (root/pose identity at rest)
FPS = 60.0
G = 7840.0            # px/s^2 (artboard is ~1.6 m tall -> ~800 px/m)
EXAG = 0.5            # share of the body acceleration felt by the ribbon (air drag / sewn top)
ZETA = 0.40
STIFF = 1.5           # cloth bending stiffness: natural frequency = STIFF * pendulum frequency
CLAMP = 0.10          # rad, safety clamp of every baked relative rotation
FOLLOW_ROT = 0.4      # cloth keeps this share of the pose rotation (rest = hang straight down)
PUSH = 0.55           # thigh rotation -> ribbon outward rotation (ratio of lever arms, see report)
PUSH_W = (0.25, 0.75, 1.0)
FLARE = 0.3           # downward body acceleration (apex of a hop / bounce) -> ribbons float outward (x ay/G)
BREEZE = ((0.008, 0.0), (0.010, -0.7), (0.013, -1.4))   # (amplitude rad, phase) for s1..s3
FADE = 16
MIN_BAKE = 0.003
BLEND = 18.0          # art px half-width of the weight blend between consecutive chain bones


def ribbon_geom(side):
    boxes = json.loads(L10.META.read_text())["boxes"]
    b = boxes[f"hem-ribbon-{side}"]
    a = np.array(Image.open(OUT / f"hem-ribbon-{side}.png"))[..., 3]
    rows = [(y, np.where(a[y] > 0)[0]) for y in range(a.shape[0])]
    wide = [(y, xs) for y, xs in rows if len(xs) >= 8]
    top, bot = wide[0][0], wide[-1][0]
    cx = {y: (xs.min() + xs.max()) / 2 for y, xs in wide}
    def centre(t):           # t in 0..1 along the visible ribbon -> mother px
        y = int(round(top + t * (bot - top)))
        ys = [k for k in cx if abs(k - y) <= 4]
        return b[0] + float(np.mean([cx[k] for k in ys])), b[1] + y
    return b, a.shape, top, bot, centre


def weight_fn_for(pivot_y, D):
    b1, b2 = D / 3, 2 * D / 3
    def f(x, y):
        d = y - pivot_y
        sm = lambda v: R8.smooth01(v)
        wa = 1.0 - sm((d + 8.0) / 8.0)                        # anchor above the pivot (thin string)
        w1 = (1.0 - wa) * (1.0 - sm((d - (b1 - BLEND)) / (2 * BLEND)))
        r = 1.0 - wa - w1
        w2 = r * (1.0 - sm((d - (b2 - BLEND)) / (2 * BLEND)))
        w3 = r - w2
        return [wa, w1, w2, w3]
    return f


def simulate(dur, tracks, ids, side, piv_world, link_len):
    pose = ids["full.pose"]
    leg = tracks.get(ids[f"full.leg-{side}.upper"], {}).get("rotation")
    n = dur + 1
    sub = 4
    dt = 1.0 / (FPS * sub)
    # anchor world position per frame (and half frames for finite differences)
    def anchor(f):
        xf, r = A.pose_xform(tracks, pose, f)
        return xf(piv_world), r
    phi = None
    out = []
    w = [math.sqrt(G / l) * STIFF for l in link_len]
    vel = [0.0, 0.0, 0.0]
    for fr in range(n):
        for k in range(sub):
            t = fr + k / sub
            (p0, r0), (p1, _), (p2, _) = anchor(t - 1 / sub), anchor(t), anchor(t + 1 / sub)
            ax = (p2[0] - 2 * p1[0] + p0[0]) / (dt * dt) * EXAG
            ay = (p2[1] - 2 * p1[1] + p0[1]) / (dt * dt) * EXAG
            lg = A.eval_track(leg, t) if leg else 0.0
            push = PUSH * (max(0.0, lg) if side == "l" else min(0.0, lg))
            gm = min(2.0, max(0.3, 1.0 + ay / G))
            flare = FLARE * max(0.0, ay) / G * (1.0 if side == "l" else -1.0)
            tgt = [r0 * FOLLOW_ROT + (push + flare) * PUSH_W[i] for i in range(3)]
            if phi is None:
                phi = list(tgt)
            for i in range(3):
                acc = -(w[i] ** 2) * gm * (phi[i] - tgt[i]) - 2 * ZETA * w[i] * vel[i] - ax / link_len[i] * math.cos(phi[i])
                vel[i] += acc * dt
                phi[i] += vel[i] * dt
        r = A.pose_xform(tracks, pose, fr)[1]
        th = [phi[0] - r, phi[1] - phi[0], phi[2] - phi[1]]
        fade = R8.smooth01((dur - fr) / FADE) * R8.smooth01(fr / 4.0)
        out.append([max(-CLAMP, min(CLAMP, v)) * fade for v in th])
    return np.array(out)


def main():
    scene = SCENE.read_text(encoding="utf-8")
    lic = json.loads(LICENSE.read_text())
    meta_txt = L10.META.read_text()
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    anims = A.animations(scene)
    report = {"removed": [], "ribbons": {}, "baked": {}}
    # ---------------------------------------------------------------- 1. coat tails (hidden duplicates)
    for side in "lr":
        nm = f"full.coat-{side}.tail.image"
        m = re.search(rf'<Image name="{re.escape(nm)}" assetId="(0:\d+)"', scene)
        if not m:
            continue
        aid = m.group(1)
        scene = R8.remove_elem(scene, "Image", nm)
        am = re.search(rf'\s*<ImageAsset name="[^"]*" file="([^"]+)" id="{aid}"/>', scene)
        scene = scene[:am.start()] + scene[am.end():]
        f = am.group(1)
        lic["assets"].pop(f, None)
        (PROJECT / f).unlink(missing_ok=True)
        report["removed"].append(f)
    # ---------------------------------------------------------------- 1b. base duplicates of the ribbons
    # fullbody-base still carries the ribbon outline pixels under the ribbon crop (drawn twice at rest, and left
    # behind as an orange ghost outline as soon as the ribbon moves) -> cleared where the ribbon crop has alpha.
    boxes = json.loads(L10.META.read_text())["boxes"]
    bp = OUT / "fullbody-base-no-head-arms.png"
    base = np.array(Image.open(bp).convert("RGBA"))
    cleared = {}
    for side in "lr":
        b = boxes[f"hem-ribbon-{side}"]
        r = np.array(Image.open(OUT / f"hem-ribbon-{side}.png"))[..., 3] > 0
        sub = base[b[1]:b[1] + r.shape[0], b[0]:b[0] + r.shape[1]]
        cleared[side] = int(((sub[..., 3] > 0) & r).sum())
        sub[r] = 0
    Image.fromarray(base).save(bp)
    rel = "reference/svg-rig/fullbody-base-no-head-arms.png"
    lic["assets"][rel].update(sha256=hashlib.sha256(bp.read_bytes()).hexdigest(), bytes=bp.stat().st_size)
    report["base_cleared"] = cleared
    # ---------------------------------------------------------------- 2. ribbons -> skinned chains
    chain_ids = {}
    for side in "lr":
        box, shape, top, bot, centre = ribbon_geom(side)
        cx0, cy0 = R8.art(*centre(0.0))
        cx1, cy1 = R8.art(*centre(1 / 3))
        cx2, cy2 = R8.art(*centre(2 / 3))
        cx3, cy3 = R8.art(*centre(1.0))
        D = cy3 - cy0
        coat = COAT[side]
        P = (cx0 - coat[0], cy0 - coat[1])            # pivot in coat space
        aname = f"full.hem.ribbon.{side}"
        anchor_id = ids[aname]
        s_ids = [R8.nid("bone") for _ in range(3)]
        chain_ids[side] = s_ids
        # child offsets (parent-local, all rotations 0 at rest)
        o2 = (cx1 - cx0, cy1 - cy0)
        o3 = (cx2 - cx1, cy2 - cy1)
        b3 = R8.bone(f"{aname}.s3", o3[0], o3[1], s_ids[2])
        b2 = R8.bone(f"{aname}.s2", o2[0], o2[1], s_ids[1], inner=b3)
        b1 = R8.bone(f"{aname}.s1", 0.0, 0.0, s_ids[0], inner=b2)
        anchor = (f'<RootBone name="{aname}" x="{P[0]:.4f}" y="{P[1]:.4f}" rotation="0" length="1" scaleX="1" '
                  f'id="{anchor_id}">{b1}</RootBone>')
        # skinned image in coat space
        aid = re.search(rf'<Image name="{re.escape(aname)}.image" assetId="(0:\d+)"', scene).group(1)
        bones = [(anchor_id, P), (s_ids[0], P), (s_ids[1], (P[0] + o2[0], P[1] + o2[1])),
                 (s_ids[2], (P[0] + o2[0] + o3[0], P[1] + o2[1] + o3[1]))]
        wf_world = weight_fn_for(cy0, D)
        wf = lambda x, y, wf_world=wf_world, coat=coat: wf_world(x + coat[0], y + coat[1])
        img = R8.image_mesh(f"{aname}.image", aid, box, (7.0, 9.0), wf, bones, parent_origin=coat)
        scene = R8.replace_elem(scene, "RootBone", aname, anchor + "\n                    " + img)
        L1 = [(cy1 - cy0) / 2 + 10, (cy1 - cy0) + (cy2 - cy1) / 2, (cy2 - cy0) + (cy3 - cy2) / 2]
        report["ribbons"][side] = {"pivot_world": [round(cx0, 2), round(cy0, 2)], "length": round(D, 1),
                                   "bones": [aname, f"{aname}.s1", f"{aname}.s2", f"{aname}.s3"], "link_len": [round(v, 1) for v in L1]}
    # ---------------------------------------------------------------- 3. motion
    for an, (dur, tracks) in anims.items():
        if an == "rest":
            continue
        for side in "lr":
            s_ids = chain_ids[side]
            rb = report["ribbons"][side]
            if an == "full.idle":
                xml = ""
                for i, (amp, ph) in enumerate(BREEZE):
                    sgn = 1.0 if side == "l" else -1.0
                    fv = [(f, sgn * amp * math.sin(2 * math.pi * f / dur + ph + (0.0 if side == "l" else 0.9))) for f in range(0, dur + 1, 4)]
                    xml += A.linear_track(s_ids[i], "rotation", fv)
                scene = A.add_to_anim(scene, an, xml)
                report["baked"].setdefault(an, {})[side] = max(a for a, _ in BREEZE)
                continue
            th = simulate(dur, tracks, ids, side, tuple(rb["pivot_world"]), rb["link_len"])
            mx = float(np.abs(th).max())
            if mx < MIN_BAKE:
                continue
            frames = list(range(0, dur + 1, 2))
            if frames[-1] != dur:
                frames.append(dur)
            xml = "".join(A.linear_track(s_ids[i], "rotation", [(f, float(th[f, i])) for f in frames]) for i in range(3))
            scene = A.add_to_anim(scene, an, xml)
            report["baked"].setdefault(an, {})[side] = round(mx, 4)
    if "ROUND13 hem" not in scene:
        scene = scene.replace("<!-- ROUND7-FULL-DECOMPOSE -->\n",
                              "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND13 hem: skinned ribbon chains, coat-tail duplicates removed -->\n", 1)
    SCENE.write_text(scene, encoding="utf-8")
    # rig-meta: drop removed boxes; license
    meta = json.loads(meta_txt)
    for f in report["removed"]:
        k = f.split("/")[-1][:-4]
        if k in meta["boxes"]:
            meta_txt = re.sub(rf'\n\s*"{re.escape(k)}": \[[^\]]*\],?', "", meta_txt)
    try:
        json.loads(meta_txt)
    except Exception:
        meta_txt = json.dumps(meta | {"boxes": {k: v for k, v in meta["boxes"].items() if f"reference/svg-rig/{k}.png" not in report["removed"]}}, indent=2) + "\n"
    L10.META.write_text(meta_txt)
    note = lic.get("note", "")
    if "ROUND13 hem" not in note:
        lic["note"] = (note + " ROUND13 hem: coat-tail crops removed (fully hidden duplicates); hem ribbons unchanged pixels, now skinned.").strip()
    LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
    (L10.ROOT / "scripts/rive-complete/round13/hem-report.json").write_text(json.dumps(report, indent=1) + "\n")
    print("ROUND13 hem", json.dumps({k: report[k] for k in ("removed", "base_cleared", "ribbons")}), "baked clips:", len(report["baked"]))


if __name__ == "__main__":
    main()
