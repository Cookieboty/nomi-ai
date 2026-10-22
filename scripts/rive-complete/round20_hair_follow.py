#!/usr/bin/env python3
"""ROUND20 Task A — back hair + bow follow body motion with lag (handoff §6 item 4).

1. Extract neck-side hanging hair still stuck on head.png (the "后发硬板" peeks below the
   side locks) into hair-back-{l,r} with 2-bone chains + skinned meshes.
2. Re-bake side-lock (and therefore the orange bow dangling tails that live inside
   lock-r) secondary motion for wave/step/squat/hop/clap — step/squat were added in R18
   after R13 hair bake, so those clips had zero lock keys; wave was near-zero (~0.006 rad).
3. Bake the new back-hair chains on the same clips.

Idempotent. PNG changes → DETAIL_LICENSE updated.
"""
from __future__ import annotations

import hashlib
import json
import math
import re

import cv2
import numpy as np
from PIL import Image

import round8_scene as R8
import round10_layers as L10
import round13_anim as A

PROJECT, OUT = L10.PROJECT, L10.OUT
SCENE = PROJECT / "scene.rml"
LICENSE = PROJECT / "parts" / "DETAIL_LICENSE.json"
META = L10.META
S = R8.S
H, W = 1536, 1024
HEAD_LOCAL = (480.0, 253.9)
FPS, G = 60.0, 7840.0

# Neck-side peeks below the side locks (mother px). Top cut anchors to head.
BACK = {
    "l": dict(x=(368, 448), y=(240, 342), cut=258, pivot=(408, 262), edge=448),
    "r": dict(x=(575, 650), y=(248, 342), cut=264, pivot=(610, 270), edge=575),
}
SKIRT = 2
BAND = 16.0
# Lock re-bake (stronger than R13's CLAMP=0.06 so bow tails / locks read on step/squat)
LOCK_OMEGA = 2 * math.pi * 1.6
LOCK_ZETA = 0.32
LOCK_HANG = 0.30
LOCK_FLARE = 0.85
LOCK_CLAMP = 0.11
LOCK_FADE = 16
LOCK_MIN = 0.002
# Back-hair: looser / longer hang
BACK_OMEGA = 2 * math.pi * 1.2
BACK_ZETA = 0.38
BACK_HANG = 0.35
BACK_FLARE = 1.0
BACK_CLAMP = 0.14
BACK_FADE = 16
BACK_MIN = 0.002
TARGETS = ("full.wave", "full.step", "full.squat", "full.hop", "full.clap")
LOCK_REG = {
    "l": dict(cut=100, edge=444, pivot=(428, 104), ybot=263),
    "r": dict(cut=108, edge=572, pivot=(586, 112), ybot=257),
}
BREEZE = ((0.010, 0.0), (0.012, -0.8), (0.014, -1.6))  # unused here; idle kept as-is


def skin_mask(rgba):
    r, g, b, a = [rgba[..., i].astype(int) for i in range(4)]
    return (a > 0) & (r > 200) & (g > 150) & (b > 140) & (r - b < 90)


def over(dst, src):
    sa = src[..., 3:4] / 255.0
    da = dst[..., 3:4] / 255.0
    oa = sa + da * (1 - sa)
    rgb = (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / np.maximum(oa, 1e-6)
    return np.concatenate([np.clip(rgb + 0.5, 0, 255), np.clip(oa * 255 + 0.5, 0, 255)], -1).astype(np.uint8)


def head_fk(tracks, ids, f):
    pose_fn, pr = A.pose_xform(tracks, ids["full.pose"], f)
    def rot(nm):
        t = tracks.get(ids[nm], {}).get("rotation")
        return (A.eval_track(t, f) or 0.0) if t else 0.0
    rt, rn, rh = rot("full.torso"), rot("full.neck"), rot("full.head")
    def fn(p):
        x, y = p
        c, s = math.cos(rh + rn), math.sin(rh + rn)
        x, y = c * x - s * y, s * x + c * y
        y -= 406.1
        c, s = math.cos(rt), math.sin(rt)
        x, y = c * x - s * y + 480.0, s * x + c * y + 660.0
        return pose_fn((x, y))
    return fn, pr + rt + rn + rh


def simulate(dur, tracks, ids, piv_local, lens, side, *, omega, zeta, hang, flare, clamp, fade):
    sub, dt = 4, 1.0 / (FPS * 4)
    th, vel, out = None, [0.0] * len(lens), []
    sgn = 1.0 if side == "l" else -1.0
    nlink = len(lens)
    for fr in range(dur + 1):
        for k in range(sub):
            t = fr + k / sub
            (f0, r0), (f1, r1), (f2, r2) = head_fk(tracks, ids, t - 1 / sub), head_fk(tracks, ids, t), head_fk(tracks, ids, t + 1 / sub)
            p0, p1, p2 = f0(piv_local), f1(piv_local), f2(piv_local)
            ax, ay = [(p2[i] - 2 * p1[i] + p0[i]) / dt ** 2 for i in (0, 1)]
            alpha = (r2 - 2 * r1 + r0) / dt ** 2
            c, s = math.cos(-r1), math.sin(-r1)
            axl, ayl = c * ax - s * ay, s * ax + c * ay
            tgt = -hang * r1 + flare * max(0.0, ayl) / G * sgn
            # pose vertical bounce (hop/squat/step) drives hair even when head angle is flat
            pose = tracks.get(ids["full.pose"], {})
            if "y" in pose:
                y_m = A.eval_track(pose["y"], t - 1 / sub) or 0.0
                y_0 = A.eval_track(pose["y"], t) or 0.0
                y_p = A.eval_track(pose["y"], t + 1 / sub) or 0.0
                ay_pose = (y_p - 2 * y_0 + y_m) / (dt * dt)
                tgt += flare * 0.55 * max(0.0, ay_pose) / G * sgn
                tgt -= 0.08 * (y_0 / 80.0) * sgn  # slight outward when rising
            gm = min(2.0, max(0.3, 1.0 + ayl / G))
            if th is None:
                th = [tgt] * nlink
            for i in range(nlink):
                acc = -(omega ** 2) * gm * (th[i] - tgt) - 2 * zeta * omega * vel[i] - alpha - axl / max(lens[i], 8.0)
                vel[i] += acc * dt
                th[i] += vel[i] * dt
        rel = [th[0]] + [th[i] - th[i - 1] for i in range(1, nlink)]
        fd = R8.smooth01((dur - fr) / fade) * R8.smooth01(fr / 4.0)
        out.append([clamp * math.tanh(v / clamp) * fd for v in rel])
    return np.array(out)


def strip_keys(scene: str, anim: str, obj_ids: list[str]) -> str:
    a, b = R8.find_elem(scene, "LinearAnimation", anim)
    body = scene[a:b]
    for oid in obj_ids:
        body = re.sub(rf'\n?\s*<KeyedObject objectId="{re.escape(oid)}">.*?</KeyedObject>', "", body, flags=re.S)
    return scene[:a] + body + scene[b:]


def refresh_license(lic, rel):
    p = PROJECT / rel
    e = lic["assets"].get(rel) or {}
    e.update(
        sha256=hashlib.sha256(p.read_bytes()).hexdigest(),
        bytes=p.stat().st_size,
        ai_generated=False,
        in_scene=True,
        method=e.get("method", "deterministic source-pixel rig layer derived from user supplied full-body mother"),
    )
    lic["assets"][rel] = e


def extract_back_hair(boxes, head_rgba_full):
    """Move neck-side hair peeks out of the head canvas into hair-back crops. Returns pieces + mutated head canvas."""
    hair = ~skin_mask(head_rgba_full) & (head_rgba_full[..., 3] > 0)
    pieces = {}
    report = {}
    for side, rg in BACK.items():
        m = np.zeros((H, W), bool)
        m[rg["y"][0]:rg["y"][1], rg["x"][0]:rg["x"][1]] = True
        m &= hair
        # keep components touching the vertical strip (drop freckles)
        n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        keep = np.zeros_like(m)
        for i in range(1, n):
            if st[i, 4] >= 40:
                keep |= lab == i
        m = keep
        # only take from head canvas (caller already composited head into full)
        sel = m & (head_rgba_full[..., 3] > 0)
        comp = np.where(sel[..., None], head_rgba_full, 0).astype(np.uint8)
        head_rgba_full[sel] = 0
        # skirt from remaining head
        k = 2 * SKIRT + 1
        ring = cv2.dilate(sel.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))) > 0
        # skirt: opaque-ish neighbours across the cut (incl. AA fringe). Prefer non-skin;
        # if a skin pixel is the only neighbour (cheek), skip it so we do not steal face.
        sk = ring & ~sel & (head_rgba_full[..., 3] > 180) & (comp[..., 3] == 0)
        sk_hair = sk & ~skin_mask(head_rgba_full)
        comp[sk_hair] = head_rgba_full[sk_hair]
        # also pull a 1px ring of remaining head hair ABOVE the cut into the piece as overlap
        # (still owned by head) so bilinear gaps close at rest — same idea as R13 lock skirt.
        sk = sk_hair
        ys, xs = np.where(comp[..., 3] > 0)
        if len(xs) < 30:
            report[side] = {"px": 0, "skipped": True}
            continue
        bb = [int(xs.min()) - 2, int(ys.min()) - 2, int(xs.max()) + 3, int(ys.max()) + 3]
        bb = [max(0, bb[0]), max(0, bb[1]), min(W, bb[2]), min(H, bb[3])]
        crop = comp[bb[1]:bb[3], bb[0]:bb[2]]
        name = f"hair-back-{side}"
        Image.fromarray(crop).save(OUT / f"{name}.png")
        boxes[name] = bb
        pieces[side] = (name, bb, crop, rg)
        report[side] = {"px": int(sel.sum()), "skirt_px": int(sk.sum()), "box": bb}
    return pieces, report, head_rgba_full


def main():
    scene = SCENE.read_text(encoding="utf-8")
    # idempotent: if already converted (s1 bones exist), skip structural rebuild but still re-bake
    already = 'name="full.hair.back.l.s1"' in scene
    lic = json.loads(LICENSE.read_text())
    meta = json.loads(META.read_text())
    boxes = meta["boxes"]
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 3000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})

    report = {"back": {}, "baked_lock": {}, "baked_back": {}, "already": already}

    if not already:
        # --- extract peeks from head ---
        hb = boxes["head"]
        head_img = np.array(Image.open(OUT / "head.png").convert("RGBA"))
        full = np.zeros((H, W, 4), np.uint8)
        full[hb[1]:hb[1] + head_img.shape[0], hb[0]:hb[0] + head_img.shape[1]] = head_img
        pieces, brep, full = extract_back_hair(boxes, full)
        report["back"] = brep
        # write trimmed head
        new_head = full[hb[1]:hb[1] + head_img.shape[0], hb[0]:hb[0] + head_img.shape[1]]
        Image.fromarray(new_head).save(OUT / "head.png")

        # --- remove old empty rigid back-hair bones+images ---
        for side in "lr":
            scene = R8.remove_elem(scene, "RootBone", f"full.hair.back.{side}")

        # --- insert skinned meshes + 2-bone chains under full.head ---
        head_id = ids["full.head"]
        xml_imgs, xml_bones = [], []
        chain = {}
        for side, (name, bb, crop, rg) in pieces.items():
            px, py = R8.art(*rg["pivot"])
            lx, ly = px - HEAD_LOCAL[0], py - HEAD_LOCAL[1]
            Lm = (bb[3] - rg["cut"])  # mother px hanging length
            seg = Lm / 2 * S
            bid = [R8.nid("bone") for _ in range(2)]
            chain[side] = bid
            bn = f"full.hair.back.{side}"
            b2 = R8.bone(f"{bn}.s2", 0.0, seg, bid[1])
            b1 = R8.bone(f"{bn}.s1", lx, ly, bid[0], inner=b2)
            xml_bones.append(b1)
            # reuse existing ImageAsset ids for hair-back
            asset_id = ids.get(f"full.hair.back.{side}.image")  # gone with bone — look up asset by file
            # find asset id from ImageAsset name
            am = re.search(rf'<ImageAsset name="fullbody-hair-back-{side}"[^>]*\bid="(0:\d+)"', scene)
            aid = am.group(1) if am else R8.nid("asset")
            sgn = 1.0 if side == "l" else -1.0

            def wf(x, y, rg=rg, sgn=sgn, Lm=Lm):
                mx, my = (x + HEAD_LOCAL[0] - R8.OX) / S, (y + HEAD_LOCAL[1] - R8.OY) / S
                d_cut = my - rg["cut"]
                d_edge = (rg["edge"] - mx) * sgn
                free = R8.smooth01(d_cut / BAND) * R8.smooth01(d_edge / max(BAND * 0.6, 1))
                t = max(0.0, d_cut) / max(Lm, 1)
                w1 = 1 - R8.smooth01((t - 0.35) / 0.25)
                w2 = max(0.0, 1 - w1)
                return [1 - free, free * w1, free * w2]

            bones = [
                (head_id, (0.0, 0.0)),
                (bid[0], (lx, ly)),
                (bid[1], (lx, ly + seg)),
            ]
            xml_imgs.append(
                R8.image_mesh(f"full.hair.back.{side}.image", aid, bb, (5.0, 5.0), wf, bones, parent_origin=HEAD_LOCAL)
            )
            report["back"][side]["chain_len_art"] = round(Lm * S, 1)
            report["back"][side]["bone_ids"] = bid

        a, _ = R8.find_elem(scene, "RootBone", "full.head")
        tag_end = scene.index(">", a) + 1
        scene = scene[:tag_end] + "\n" + "\n".join(xml_imgs + xml_bones) + scene[tag_end:]

        # update meta boxes
        meta["boxes"] = boxes
        META.write_text(json.dumps(meta, indent=2) + "\n")
        for side in pieces:
            refresh_license(lic, f"reference/svg-rig/hair-back-{side}.png")
        refresh_license(lic, "reference/svg-rig/head.png")
        note = lic.get("note", "")
        if "ROUND20 backhair" not in note:
            lic["note"] = (note + " ROUND20 backhair: neck-side peeks moved from head into hair-back-{l,r} skinned chains.").strip()
        LICENSE.write_text(json.dumps(lic, indent=2) + "\n")
        # refresh ids after structural change
        ids = A.ids_by_name(scene)
        # persist chain ids into a small report for re-bake path
        chain_ids = {s: report["back"][s]["bone_ids"] for s in chain}
    else:
        chain_ids = {
            "l": [ids["full.hair.back.l.s1"], ids["full.hair.back.l.s2"]],
            "r": [ids["full.hair.back.r.s1"], ids["full.hair.back.r.s2"]],
        }
        # re-read boxes for lens
        for side, rg in BACK.items():
            bb = boxes.get(f"hair-back-{side}")
            if bb:
                report["back"][side] = {"box": bb, "chain_len_art": round((bb[3] - rg["cut"]) * S, 1), "bone_ids": chain_ids[side]}

    # --- re-bake locks + back for TARGETS ---
    lock_ids = {
        s: [ids[f"full.hair.lock.{s}.s{i}"] for i in (1, 2, 3)] for s in "lr"
    }
    anims = A.animations(scene)
    for an in TARGETS:
        if an not in anims:
            report["baked_lock"][an] = "MISSING"
            continue
        # strip prior lock + back keys
        strip = []
        for s in "lr":
            strip.extend(lock_ids[s])
            if s in chain_ids:
                strip.extend(chain_ids[s])
        scene = strip_keys(scene, an, strip)
        anims = A.animations(scene)
        dur, tracks = anims[an]

        # locks
        xml = ""
        side_max = {}
        for side in "lr":
            rg = LOCK_REG[side]
            px, py = R8.art(*rg["pivot"])
            piv = (px - HEAD_LOCAL[0], py - HEAD_LOCAL[1])
            Lart = (rg["ybot"] - rg["cut"]) * S
            lens = [Lart / 6 + 8, Lart / 2, Lart * 5 / 6]
            th = simulate(
                dur, tracks, ids, piv, lens, side,
                omega=LOCK_OMEGA, zeta=LOCK_ZETA, hang=LOCK_HANG,
                flare=LOCK_FLARE, clamp=LOCK_CLAMP, fade=LOCK_FADE,
            )
            mx = float(np.abs(th).max())
            side_max[side] = round(mx, 4)
            if mx < LOCK_MIN:
                continue
            frames = list(range(0, dur + 1, 2))
            if frames[-1] != dur:
                frames.append(dur)
            xml += "".join(
                A.linear_track(lock_ids[side][i], "rotation", [(f, float(th[f, i])) for f in frames])
                for i in range(3)
            )
        report["baked_lock"][an] = side_max

        # back hair
        bmax = {}
        for side in "lr":
            if side not in chain_ids or side not in report["back"] or "chain_len_art" not in report["back"].get(side, {}):
                # try from boxes
                if f"hair-back-{side}" not in boxes:
                    continue
                rg = BACK[side]
                Lart = (boxes[f"hair-back-{side}"][3] - rg["cut"]) * S
            else:
                rg = BACK[side]
                Lart = report["back"][side]["chain_len_art"]
            px, py = R8.art(*rg["pivot"])
            piv = (px - HEAD_LOCAL[0], py - HEAD_LOCAL[1])
            lens = [Lart / 3 + 6, Lart * 2 / 3]
            th = simulate(
                dur, tracks, ids, piv, lens, side,
                omega=BACK_OMEGA, zeta=BACK_ZETA, hang=BACK_HANG,
                flare=BACK_FLARE, clamp=BACK_CLAMP, fade=BACK_FADE,
            )
            mx = float(np.abs(th).max())
            bmax[side] = round(mx, 4)
            if mx < BACK_MIN:
                continue
            frames = list(range(0, dur + 1, 2))
            if frames[-1] != dur:
                frames.append(dur)
            xml += "".join(
                A.linear_track(chain_ids[side][i], "rotation", [(f, float(th[f, i])) for f in frames])
                for i in range(2)
            )
        report["baked_back"][an] = bmax
        if xml:
            scene = A.add_to_anim(scene, an, xml)

    if "ROUND20 hair-follow" not in scene:
        scene = scene.replace(
            "<!-- ROUND7-FULL-DECOMPOSE -->\n",
            "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND20 hair-follow: back-hair chains + lock/bow lag on step/squat/wave/hop/clap -->\n",
            1,
        )
    SCENE.write_text(scene, encoding="utf-8")

    build = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = build.read_text()
    if "round20_hair_follow" not in bt:
        build.write_text(bt.rstrip() + "\npython3 round20_hair_follow.py\n")

    (L10.ROOT / "scripts/rive-complete/round13/hair-follow-r20.json").write_text(json.dumps(report, indent=1) + "\n")
    print("ROUND20 hair-follow", json.dumps(report))


if __name__ == "__main__":
    main()
