#!/usr/bin/env python3
"""ROUND18 — formal leg clips: `full.step` (walk in place) and `full.squat`.

Rig facts: full.leg-{l,r}.upper are children of full.root (siblings of full.pelvis / full.torso), the whole figure
moves with the full.pose node, so a hip drop / weight shift is a full.pose translation and every planted foot is held
in place by solving its leg (2-bone, front view):
  * upper.rotation  a  = knee-out angle (designed, small; + = screen-left, i.e. outward for leg-l)
  * upper.scaleY    s  = thigh foreshortening (a front-view knee coming forward / up shortens the thigh on screen)
  * lower.rotation  b, lower.scaleY 1/s (the shin keeps its length)
  * foot.rotation   f  keeps the foot flat on the floor (world angle 0)
  (s, b) are solved per baked frame (every 2 f, linear keys) by Newton so the ankle lands on its target in world space:
  planted feet stay exactly on the rest ankle; the swing foot follows a lift arc.  full.pose scaleY is held at 1 so
  the idle breathing scale does not slide the feet during the clips.
Front view limits (honest): hips shifting back / torso leaning forward have no screen axis here; they are suggested
by a head dip + shoulders (arms) moving in.  ROUND19 deepens squat drop 42→100 art px (~7.7% of artboard) with
stronger thigh foreshortening from the planted-foot IK; knee-out stays ~0.022 so the crotch bridge stays healthy.
Idempotent."""
from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np

SCENE = Path(__file__).resolve().parents[2] / "rive/nomi-complete/scene.rml"
FPS = 60
IDS = {  # bones
    "pose": "0:190", "head": "0:9212", "torso": "0:9211",
    "l.upper": "0:9235", "l.lower": "0:9236", "l.foot": "0:9237",
    "r.upper": "0:9238", "r.lower": "0:9239", "r.foot": "0:9240",
    "arm-l": "0:9213", "arm-r": "0:9219",
}
ARM_REST = {"arm-l": 1.6881204551454159, "arm-r": 1.4534721984443775}
CLIPS = {  # name: (trigger id, anim id, state id, state y)
    "step": ("0:292", "0:60101", "0:60111", 1920),
    "squat": ("0:293", "0:60102", "0:60112", 1980),
}


def leg_rest(scene, side):
    def bone(n):
        m = re.search(rf'<RootBone name="full\.leg-{side}\.{n}" x="([-\d.]+)" y="([-\d.]+)"', scene)
        return float(m.group(1)), float(m.group(2))
    return bone("upper"), bone("lower"), bone("ankle")


def M(x, y, r, sx=1.0, sy=1.0):
    c, s = math.cos(r), math.sin(r)
    return np.array([[c * sx, -s * sy, x], [s * sx, c * sy, y], [0, 0, 1.0]])


def ankle_world(rest, pose, a, s, b):
    (ux, uy), (lx, ly), (ax, ay) = rest
    W = M(pose[0], pose[1], 0) @ M(ux, uy, a, 1, s) @ M(lx, ly, b, 1, 1 / s) @ M(ax, ay, 0)
    return W


def solve(rest, pose, a, target, s0=1.0, b0=0.0):
    s, b = s0, b0
    for _ in range(50):
        p = ankle_world(rest, pose, a, s, b)[:2, 2]
        e = p - target
        if np.abs(e).max() < 1e-6:
            break
        J = np.zeros((2, 2))
        for i, (ds, db) in enumerate(((1e-6, 0), (0, 1e-6))):
            J[:, i] = (ankle_world(rest, pose, a, s + ds, b + db)[:2, 2] - p) / 1e-6
        d = np.linalg.solve(J, -e)
        s, b = s + d[0], b + d[1]
    W = ankle_world(rest, pose, a, s, b)
    f = -math.atan2(-W[0, 1], W[1, 1])     # align the foot's down axis (ankle -> sole) with world vertical
    return s, b, f, float(np.abs(W[:2, 2] - target).max())


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- clip definitions (per frame -> pose + leg targets)
STEP_T, STEPS, SETTLE = 34, 4, 14            # 34 f = 0.57 s per step, 4 steps (L R L R), 14 f settle
LIFT, KNEE_OUT, SHIFT, BOB, ARM = 26.0, 0.025, 7.0, 4.0, 0.045


def step_frame(f):
    """returns pose (x, y), {side: (a, lift)}, arm offsets, head dy"""
    n = STEPS * STEP_T
    if f >= n:
        k = 1 - ease((f - n) / SETTLE)            # settle: the last contact dip eases back to rest height
        return (0.0, BOB * k), {"l": (0, 0), "r": (0, 0)}, {"arm-l": 0, "arm-r": 0}, 0.0, k
    i, t = divmod(f, STEP_T)
    t /= STEP_T
    swing = "l" if i % 2 == 0 else "r"
    env = ease(f / 10)                            # ramp in over the first 10 f
    lift = LIFT * math.sin(math.pi * t) ** 1.3 * env
    # weight shift toward the stance leg (peaks at passing), body bob: low at contact, high at passing
    side_sign = 1.0 if swing == "l" else -1.0     # stance = r (screen right, +x) while l swings
    x = SHIFT * side_sign * math.sin(math.pi * t) * env
    y = BOB * (0.5 + 0.5 * math.cos(2 * math.pi * t)) * env
    a_sw = (1 if swing == "l" else -1) * KNEE_OUT * math.sin(math.pi * t) * env
    legs = {swing: (a_sw, lift), ("r" if swing == "l" else "l"): (0.0, 0.0)}
    # counter arm swing: arm opposite the lifted leg comes forward (front view: hand moves in toward the body)
    sw = math.sin(math.pi * t) * env
    arms = {"arm-l": 0.0, "arm-r": 0.0}
    if swing == "l":
        arms["arm-r"] = ARM * sw                  # arm-r forward: hand swings in toward the body (+ for arm-r)
        arms["arm-l"] = ARM * 0.4 * sw            # arm-l back: slightly out (+ for arm-l)
    else:
        arms["arm-l"] = -ARM * sw                 # arm-l forward: in (- for arm-l)
        arms["arm-r"] = -ARM * 0.4 * sw           # arm-r back: slightly out (- for arm-r)
    return (x, y), legs, arms, 0.0, 1.0


SQ_DOWN, SQ_HOLD, SQ_UP, SQ_SETTLE = 24, 18, 30, 8      # 0.4 s down, 0.3 s hold, 0.5 s up
SQ_DROP, SQ_KNEE, SQ_HEAD, SQ_ARM = 100.0, 0.022, 10.0, 0.05  # R19: deepen (~7.7% artboard); knee kept tiny for crotch


def squat_curve(f):
    if f < SQ_DOWN:
        return ease(f / SQ_DOWN)
    f -= SQ_DOWN
    if f < SQ_HOLD:
        return 1.0
    f -= SQ_HOLD
    if f < SQ_UP:
        return 1 - ease(f / SQ_UP)
    return 0.0


def squat_frame(f):
    c = squat_curve(f)
    legs = {"l": (SQ_KNEE * c, 0.0), "r": (-SQ_KNEE * c, 0.0)}
    arms = {"arm-l": -SQ_ARM * c, "arm-r": SQ_ARM * c}   # hands come in / forward for balance
    # torso_rot: tiny frontal "weight" cue (not a true lean — no depth axis); positive = CW
    return (0.0, SQ_DROP * c), legs, arms, SQ_HEAD * c, 1.0, 0.025 * c


def bake(scene, name, fn, dur):
    rest = {s: leg_rest(scene, s) for s in "lr"}
    tracks = {}
    worst = 0.0
    frames = list(range(0, dur + 1, 2))
    if frames[-1] != dur:
        frames.append(dur)
    st = {s: (1.0, 0.0) for s in "lr"}
    feet = {s: [] for s in "lr"}

    def put(obj, prop, f, v):
        tracks.setdefault((obj, prop), []).append((f, v))
    for f in frames:
        out = fn(f)
        if len(out) == 5:
            pose, legs, arms, head_dy, k = out
            torso_rot = 0.0
        else:
            pose, legs, arms, head_dy, k, torso_rot = out
        for s in "lr":
            a, lift = legs[s]
            A0 = ankle_world(rest[s], (0, 0), 0, 1, 0)[:2, 2]
            tgt = A0 + np.array([0.0, -lift])
            sv, bv, fv, err = solve(rest[s], pose, a, tgt, *st[s])
            st[s] = (sv, bv)
            worst = max(worst, err)
            feet[s].append((f, lift, err))
            put(IDS[f"{s}.upper"], "rotation", f, a)
            put(IDS[f"{s}.upper"], "scaleY", f, sv)
            put(IDS[f"{s}.lower"], "rotation", f, bv)
            put(IDS[f"{s}.lower"], "scaleY", f, 1 / sv)
            put(IDS[f"{s}.foot"], "rotation", f, fv)
        put(IDS["pose"], "x", f, pose[0])
        put(IDS["pose"], "y", f, pose[1])
        put(IDS["pose"], "scaleY", f, 1.0)
        put(IDS["head"], "y", f, head_dy)
        if "torso" in IDS:
            put(IDS["torso"], "rotation", f, torso_rot)
        for arm, off in arms.items():
            put(IDS[arm], "rotation", f, ARM_REST[arm] + off)
    body = ""
    for (obj, prop), kf in tracks.items():
        ks = "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in kf)
        body += f'            <KeyedObject objectId="{obj}"><KeyedProperty property="{prop}">{ks}</KeyedProperty></KeyedObject>\n'
    return body, worst


def main():
    s = SCENE.read_text(encoding="utf-8")
    # idempotent cleanup
    for name, (tid, aid, sid, _) in CLIPS.items():
        s = re.sub(rf'\n\s*<ViewModelPropertyTrigger name="{name}" id="{tid}"/>', "", s)
        s = re.sub(rf'\n\s*<ViewModelInstanceTrigger viewModelPropertyId="{tid}"/>', "", s)
        s = re.sub(rf'\n\s*<LinearAnimation name="full\.{name}".*?</LinearAnimation>', "", s, flags=re.S)
        s = re.sub(rf'\n\s*<AnimationState [^>]*id="{sid}">.*?</AnimationState>', "", s, flags=re.S)
        s = re.sub(rf'\n\s*<StateTransition stateToId="{sid}" duration="12">.*?</StateTransition>', "", s, flags=re.S)
    import sys
    only = sys.argv[1:] or list(CLIPS)
    rep = {}
    for name in only:
        tid, aid, sid, sy = CLIPS[name]
        if name == "step":
            dur = STEPS * STEP_T + SETTLE
            body, worst = bake(s, name, step_frame, dur)
        else:
            dur = SQ_DOWN + SQ_HOLD + SQ_UP + SQ_SETTLE
            body, worst = bake(s, name, squat_frame, dur)
        rep[name] = (dur, worst)
        anim = f'\n        <LinearAnimation name="full.{name}" loopValue="oneShot" duration="{dur}" fps="{FPS}" id="{aid}">\n{body}        </LinearAnimation>'
        m = re.search(r'<LinearAnimation name="full\.fist".*?</LinearAnimation>', s, re.S)
        s = s[:m.end()] + anim + s[m.end():]
        s = s.replace('<ViewModelPropertyTrigger name="fist" id="0:291"/>',
                      f'<ViewModelPropertyTrigger name="fist" id="0:291"/>\n        <ViewModelPropertyTrigger name="{name}" id="{tid}"/>', 1)
        s = s.replace('<ViewModelInstanceTrigger viewModelPropertyId="0:291"/>',
                      f'<ViewModelInstanceTrigger viewModelPropertyId="0:291"/>\n            <ViewModelInstanceTrigger viewModelPropertyId="{tid}"/>', 1)
        tr = (f'\n                    <StateTransition stateToId="{sid}" duration="12">\n'
              '                        <TransitionViewModelCondition>\n'
              '                            <TransitionPropertyViewModelComparator>\n'
              '                                <BindablePropertyTrigger>\n'
              f'                                    <DataBindContext sourcePathIds="0:9100-{tid}" propertyKey="686"/>\n'
              '                                </BindablePropertyTrigger>\n'
              '                            </TransitionPropertyViewModelComparator>\n'
              '                            <TransitionValueTriggerComparator/>\n'
              '                        </TransitionViewModelCondition>\n'
              '                    </StateTransition>')
        m = re.search(r'<AnimationState [^>]*id="0:222">.*?(\n\s*</AnimationState>)', s, re.S)
        s = s[:m.start(1)] + tr + s[m.start(1):]
        st = (f'\n                <AnimationState x="720" y="{sy}" animationId="{aid}" id="{sid}">\n'
              '                    <StateTransition stateToId="0:222" duration="18" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>\n'
              '                </AnimationState>')
        m = re.search(r'<StateMachineLayer name="Actions".*?(\n\s*</StateMachineLayer>)', s, re.S)
        s = s[:m.start(1)] + st + s[m.start(1):]
    SCENE.write_text(s, encoding="utf-8")
    for k, (d, w) in rep.items():
        print(f"ROUND18 {k}: {d} f ({d / FPS:.2f} s), worst planted-ankle solve error {w:.2e} art px")


if __name__ == "__main__":
    main()
