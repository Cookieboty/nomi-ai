#!/usr/bin/env python3
"""ROUND19 Task A — hem ribbons react to arm/leg motion with lag (wave/clap/step/squat).

Handoff §6 item 12: ribbons were parented to the coat/body only; R13 baked secondary motion for
clips that already existed then (pose accel + thigh push), but wave/clap had no keys and step/squat
were added later (R18) without ribbon bake.  This round re-bakes s1/s2/s3 rotation for those four
clips with an added ipsilateral-arm angular-accel term (laggy), so ribbons flick with wave/clap and
sway with step/squat legs — without reparenting (brand-check / rest outside-hem stay put).
Idempotent.
"""
from __future__ import annotations

import json
import math
import re

import numpy as np

import round13_anim as A
import round10_layers as L10

SCENE = L10.PROJECT / "scene.rml"
REPORT = L10.ROOT / "scripts/rive-complete/round13/hem-report.json"
FPS = 60.0
G = 7840.0
EXAG = 0.5
ZETA = 0.40
STIFF = 1.5
CLAMP = 0.14
FOLLOW_ROT = 0.4
PUSH = 0.55
PUSH_W = (0.25, 0.75, 1.0)
FLARE = 0.3
ARM_GAIN = 0.55          # rad of ribbon per (arm rad/s^2) / G  — laggy arm flick
ARM_W = (0.35, 0.75, 1.0)
FADE = 16
MIN_BAKE = 0.003
TARGETS = ("full.wave", "full.clap", "full.step", "full.squat")


def simulate(dur, tracks, ids, side, piv_world, link_len):
    pose = ids["full.pose"]
    leg = tracks.get(ids[f"full.leg-{side}.upper"], {}).get("rotation")
    arm = tracks.get(ids[f"full.arm-{side}.upper"], {}).get("rotation")
    arm_opp = tracks.get(ids[f"full.arm-{'r' if side == 'l' else 'l'}.upper"], {}).get("rotation")
    # rest arm angle so we use delta
    arm0 = A.eval_track(arm, 0.0) if arm else 0.0
    arm0_opp = A.eval_track(arm_opp, 0.0) if arm_opp else 0.0
    n = dur + 1
    sub = 4
    dt = 1.0 / (FPS * sub)

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
            # arm angular accel (delta from rest) -> outward flick, lagged by the spring
            arm_push = 0.0
            if arm:
                a_m = A.eval_track(arm, t - 1 / sub) - arm0
                a_0 = A.eval_track(arm, t) - arm0
                a_p = A.eval_track(arm, t + 1 / sub) - arm0
                a_acc = (a_p - 2 * a_0 + a_m) / (dt * dt)
                arm_push = ARM_GAIN * a_acc / G
                if side == "r":
                    arm_push = -arm_push
                arm_push += 0.18 * a_0 * (1.0 if side == "l" else -1.0)
            if arm_opp:
                b_0 = A.eval_track(arm_opp, t) - arm0_opp
                # contralateral leak (clap/wave cross-body tug on the far ribbon)
                arm_push += 0.08 * b_0 * (1.0 if side == "l" else -1.0)
            gm = min(2.0, max(0.3, 1.0 + ay / G))
            flare = FLARE * max(0.0, ay) / G * (1.0 if side == "l" else -1.0)
            tgt = [
                r0 * FOLLOW_ROT + (push + flare) * PUSH_W[i] + arm_push * ARM_W[i]
                for i in range(3)
            ]
            if phi is None:
                phi = list(tgt)
            for i in range(3):
                acc = -(w[i] ** 2) * gm * (phi[i] - tgt[i]) - 2 * ZETA * w[i] * vel[i] - ax / link_len[i] * math.cos(phi[i])
                vel[i] += acc * dt
                phi[i] += vel[i] * dt
        r = A.pose_xform(tracks, pose, fr)[1]
        th = [phi[0] - r, phi[1] - phi[0], phi[2] - phi[1]]
        fade = __import__("round8_scene", fromlist=["smooth01"]).smooth01((dur - fr) / FADE)
        fade *= __import__("round8_scene", fromlist=["smooth01"]).smooth01(fr / 4.0)
        out.append([max(-CLAMP, min(CLAMP, v)) * fade for v in th])
    return np.array(out)


def strip_ribbon_keys(scene: str, anim: str, s_ids: list[str]) -> str:
    a, b = __import__("round8_scene", fromlist=["find_elem"]).find_elem(scene, "LinearAnimation", anim)
    body = scene[a:b]
    for sid in s_ids:
        body = re.sub(rf'\n?\s*<KeyedObject objectId="{re.escape(sid)}">.*?</KeyedObject>', "", body, flags=re.S)
    return scene[:a] + body + scene[b:]


def main():
    scene = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(scene)
    # also alias arm upper names used by simulate
    ids["full.arm-l.upper"] = ids.get("full.arm-l.upper") or ids.get("full.arm-l")
    ids["full.arm-r.upper"] = ids.get("full.arm-r.upper") or ids.get("full.arm-r")
    rb = json.loads(REPORT.read_text())["ribbons"]
    anims = A.animations(scene)
    report = {}
    for an in TARGETS:
        if an not in anims:
            report[an] = "MISSING"
            continue
        dur, tracks = anims[an]
        # strip prior ribbon keys (idempotent)
        s_ids_all = []
        for side in "lr":
            s_ids = [ids[f"full.hem.ribbon.{side}.s{i}"] for i in (1, 2, 3)]
            s_ids_all.extend(s_ids)
        scene = strip_ribbon_keys(scene, an, s_ids_all)
        # refresh tracks after strip (ribbon keys gone — drivers unchanged)
        anims = A.animations(scene)
        dur, tracks = anims[an]
        xml = ""
        side_max = {}
        for side in "lr":
            s_ids = [ids[f"full.hem.ribbon.{side}.s{i}"] for i in (1, 2, 3)]
            th = simulate(dur, tracks, ids, side, tuple(rb[side]["pivot_world"]), rb[side]["link_len"])
            mx = float(np.abs(th).max())
            side_max[side] = round(mx, 4)
            if mx < MIN_BAKE:
                continue
            frames = list(range(0, dur + 1, 2))
            if frames[-1] != dur:
                frames.append(dur)
            xml += "".join(
                A.linear_track(s_ids[i], "rotation", [(f, float(th[f, i])) for f in frames]) for i in range(3)
            )
        if xml:
            scene = A.add_to_anim(scene, an, xml)
        report[an] = side_max
    if "ROUND19 ribbons" not in scene:
        scene = scene.replace(
            "<!-- ROUND7-FULL-DECOMPOSE -->\n",
            "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND19 ribbons: wave/clap/step/squat secondary motion -->\n",
            1,
        )
    SCENE.write_text(scene, encoding="utf-8")
    # wire into build
    build = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = build.read_text()
    if "round19_ribbons" not in bt:
        build.write_text(bt.rstrip() + "\npython3 round19_ribbons.py\n")
    print("ROUND19 ribbons", json.dumps(report))


if __name__ == "__main__":
    main()
