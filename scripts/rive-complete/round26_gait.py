#!/usr/bin/env python3
"""ROUND26 item 5 - real gait clips `full.walk` and `full.run` (separate from the R18 `full.step` march).

Front view, in place (the mascot never translates across the screen).  Per baked frame (every 2 f, linear keys):
  legs   planted-foot / swing-foot 2-bone IK from round18 (thigh rot = knee-out, thigh scaleY = front-view
         foreshortening of a knee coming FORWARD, shin rot + 1/s, foot rot keeps the sole flat).  Planted feet are
         solved onto their rest ankle every frame -> foot sliding is measured as the solve error.
  body   full.pose x (weight shift onto the stance leg) / y (bob), pelvis roll (swing-side hip drops),
         lumbar rides the pelvis (R36), chest counter-roll in round28_spine_motion, head near level.
  arms   counter-swing (arm opposite the forward leg comes forward = hand in/up in front view), shoulder helper
         bone at 0.65 x upper (R25 rule), elbow flexion as forearm rotation TOWARD the body midline (anatomical
         flex direction for a hanging arm, same sign as clap/cheer), relaxed (walk) / loose-fist (run) finger curl
         in the full.fist curl direction.
  lag    side locks, back hair, bangs, hem ribbons, ID badge: rotation driven by the body's own displacement
         over the last D frames (inertia: body moves +x -> chain tip trails -x; body drops -> tips flare out),
         gains growing down each chain.
WALK  30 f / step (120 steps/min), 8 steps; double support t<0.10 and t>0.90 of each step (both feet down, the
      contact frames); body lowest at 'down' (t~0.12), highest at 'passing/up' (t~0.55); swing lift 30 px.
RUN   20 f / step (180 steps/min), 8 steps; per-leg stance 35 % of the 40 f cycle, two flight phases of 15 %
      (both feet off the floor, pose rises 14 px); stance dip 16 px (knee flex), swing lift 70 px (big knee bend),
      head dip + slight torso/pose scaleY crouch as the front-view hint of forward lean, elbows ~32-43 deg (inward, front-view) pumping.
Idempotent (strips and rebuilds its own clips/triggers/states)."""
from __future__ import annotations
import json, math, re, sys
import numpy as np
import round13_anim as A
import round18_motions as R18
import round10_layers as L10

SCENE = L10.PROJECT / "scene.rml"
FPS = 60
CLIPS = {"walk": ("0:294", "0:60103", "0:60113", 2040), "run": ("0:295", "0:60104", "0:60114", 2100)}
FING = ("thumb", "index", "middle", "ring", "little")
SEGS = ("", ".1", ".2")
K_SH = 0.65
PEL_PIVOT, TORSO_DROP = (480.0, 610.0), 50.0   # rest full.pelvis origin; full.torso rest origin (480, 660)


def ease(t):
    t = min(max(t, 0.0), 1.0); return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ walk
W_STEP, W_N, W_SETTLE, W_RAMP = 30, 8, 16, 12
W = dict(lift=30.0, knee=0.020, shift=6.0, bob=5.0, pel=0.048, arm=0.075, elbow=0.22, elbow_sw=0.10, curl=0.12)


def walk_frame(f):
    n = W_STEP * W_N
    env = ease(f / W_RAMP) * (1 - ease((f - n) / W_SETTLE))
    i, t = divmod(min(f, n - 1e-6), W_STEP); t /= W_STEP
    swing = "l" if int(i) % 2 == 0 else "r"
    sgn = 1.0 if swing == "l" else -1.0
    u = min(max((t - 0.10) / 0.80, 0.0), 1.0)
    lift = W["lift"] * (math.sin(math.pi * u) ** 1.2) * env
    x = W["shift"] * sgn * math.sin(math.pi * t) * env
    y = W["bob"] * (0.5 + 0.5 * math.cos(2 * math.pi * (t - 0.12))) * env  # +y = down: max at t=.12 (down), 0 at .62 (up = rest height, stance leg straight, never stretched)
    legs = {swing: (sgn * W["knee"] * math.sin(math.pi * u) * env, lift), ("r" if swing == "l" else "l"): (0.0, 0.0)}
    sw = sgn * math.sin(math.pi * t) * env                       # +1 : l leg forward (passing) -> r arm forward
    arm = {"r": W["arm"] * sw, "l": W["arm"] * sw * 0.9}           # arm-r forward = +, arm-l back = + (out)
    # forward arm bends a bit more at the elbow
    elb = {"r": W["elbow"] * env + W["elbow_sw"] * max(0, sw), "l": W["elbow"] * env + W["elbow_sw"] * max(0, -sw)}
    return dict(pose=(x, y), legs=legs, arm=arm, elbow=elb, pel=-sgn * W["pel"] * math.sin(math.pi * t) * env * (1 - ease((f - n + W_STEP / 2) / (W_STEP / 2))),  # R36: weight-shift phase; R36b: last half step eases out (no stop pop)
                head_dy=0.0, curl=W["curl"] * env, sy=1.0, env=env, swing=swing, t=t)


# ------------------------------------------------------------------ run
R_CYC, R_N, R_SETTLE, R_RAMP = 40, 4, 18, 10
R = dict(stance=0.35, dip=16.0, rise=14.0, lift=70.0, knee=0.032, shift=4.0, pel=0.045, arm=0.13, abd=0.09, elbow=0.55,
         elbow_sw=0.20, curl=0.35, head=8.0, crouch=0.022)  # R40: slight front-view lean cue)


def run_frame(f):
    n = R_CYC * R_N
    env = ease(f / R_RAMP) * (1 - ease((f - n) / R_SETTLE))
    ph = (min(f, n - 1e-6) % R_CYC) / R_CYC
    st = R["stance"]
    legs, y, air = {}, 0.0, {}
    for s, off in (("l", 0.0), ("r", 0.5)):
        p = (ph - off) % 1.0
        if p < st:
            air[s] = 0.0
        else:
            uu = (p - st) / (1 - st)
            air[s] = R["lift"] * math.sin(math.pi * uu) ** 0.9
    pl = ph % 0.5
    if pl < st:                       # some foot in stance: dip (knee flex absorbing the landing)
        y = R["dip"] * math.sin(math.pi * pl / st)
        stance = "l" if ph < 0.5 else "r"
    else:                             # flight phase
        y = -R["rise"] * math.sin(math.pi * (pl - st) / (0.5 - st))
        stance = None
    y *= env
    for s in "lr":
        lift = air[s] * env
        if lift > 0 or stance != s:
            lift = max(lift, max(0.0, -y) + 2.0 * env) if stance != s else 0.0
        sgn = 1.0 if s == "l" else -1.0
        legs[s] = (sgn * R["knee"] * (air[s] / R["lift"]) * env, lift)
    # +1 = l arm forward = r leg forward (r swing is airborne 0.85..1.35, most forward ~0.15)
    fwd = math.cos(2 * math.pi * (ph - 0.15)) * env
    # weight over the stance foot: l stance (screen -x) for ph < 0.5
    x = R["shift"] * (-1.0 if ph < 0.5 else 1.0) * math.sin(math.pi * (ph % 0.5) / 0.5) * env
    arm = {"r": -R["arm"] * fwd - R["abd"] * env, "l": -R["arm"] * fwd * 0.95 + R["abd"] * env}  # + slight abduction
    elb = {"r": R["elbow"] * env + R["elbow_sw"] * max(0, -fwd), "l": R["elbow"] * env + R["elbow_sw"] * max(0, fwd)}
    pel = R["pel"] * math.cos(2 * math.pi * ((f % R_CYC) / R_CYC - 0.15)) * env   # R36b: free-running phase so the settle fades it (no freeze pop)
    return dict(pose=(x, y), legs=legs, arm=arm, elbow=elb, pel=pel, head_dy=R["head"] * env, curl=R["curl"] * env,
                sy=1.0 - R["crouch"] * env, env=env, swing=stance, t=ph)


# ------------------------------------------------------------------ bake
def bake(scene, fn, dur, D_lag):
    ids = A.ids_by_name(scene)
    an = A.animations(scene)
    fist = {}
    for s in "lr":
        for fg in FING:
            for sg in SEGS:
                k = an["full.fist"][1].get(ids[f"full.arm-{s}.{fg}{sg}"], {}).get("rotation", [])
                fist[f"full.arm-{s}.{fg}{sg}"] = max((x[1] for x in k), key=abs, default=0.0)
    rest = {s: R18.leg_rest(scene, s) for s in "lr"}
    bone_rot = {n: float(re.search(rf'<RootBone name="{re.escape(n)}"[^>]*rotation="([-\d.]+)"', scene).group(1))
                for n in [f"full.arm-{s}.{b}" for s in "lr" for b in ("upper", "fore", "hand", "shoulder")]}
    frames = list(range(0, dur + 1, 2))
    if frames[-1] != dur:
        frames.append(dur)
    tracks, log = {}, []
    stt = {s: (1.0, 0.0) for s in "lr"}
    put = lambda n, p, f, v: tracks.setdefault((ids[n], p), []).append((f, v))
    hist = {}
    for f in range(0, dur + 1):
        hist[f] = fn(f)["pose"]
    def disp(f, D):
        a = hist[f]; b = hist[max(0, f - D)]
        return a[0] - b[0], a[1] - b[1]
    worst = 0.0
    for f in frames:
        o = fn(f)
        pose = o["pose"]
        for s in "lr":
            a, lift = o["legs"][s]
            A0 = R18.ankle_world(rest[s], (0, 0), 0, 1, 0)[:2, 2]
            sv, bv, fv, err = R18.solve(rest[s], pose, a, A0 + np.array([0.0, -lift]), *stt[s])
            stt[s] = (sv, bv)
            Wm = R18.ankle_world(rest[s], pose, a, sv, bv)
            if lift == 0.0:
                worst = max(worst, err)
            log.append(dict(f=f, side=s, lift=round(lift, 3), planted=lift == 0.0, err=err, s=sv, knee=bv,
                            ankle=[float(Wm[0, 2]), float(Wm[1, 2])]))
            put(f"full.leg-{s}.upper", "rotation", f, a); put(f"full.leg-{s}.upper", "scaleY", f, sv)
            put(f"full.leg-{s}.lower", "rotation", f, bv); put(f"full.leg-{s}.lower", "scaleY", f, 1 / sv)
            put(f"full.leg-{s}.foot", "rotation", f, fv)
        put("full.pose", "x", f, pose[0]); put("full.pose", "y", f, pose[1]); put("full.pose", "scaleY", f, 1.0)
        put("full.pelvis", "rotation", f, o["pel"])
        # R36: the lumbar (full.torso: belt, waistband, tank bottom) rides the hips - same world roll as the pelvis,
        # rotated about the PELVIS pivot (torso origin sits 50 px lower), so the torso->pelvis skin band only sees a
        # rigid transform (no waist shear / scissor).  The counter-roll lives on the chest (round28_spine_motion).
        pr = o["pel"]
        put("full.torso", "rotation", f, pr)
        put("full.torso", "x", f, PEL_PIVOT[0] - TORSO_DROP * math.sin(pr))
        put("full.torso", "y", f, PEL_PIVOT[1] + TORSO_DROP * math.cos(pr))
        put("full.torso", "scaleY", f, o["sy"])
        put("full.head", "y", f, o["head_dy"])
        put("full.head", "rotation", f, -0.7 * pr)
        for s in "lr":
            ins = 1.0 if s == "r" else -1.0                       # + rotation = inward for arm-r, - for arm-l
            up = bone_rot[f"full.arm-{s}.upper"] + o["arm"][s]   # arm-r: + = in/forward; arm-l: + = out/back
            put(f"full.arm-{s}.upper", "rotation", f, up)
            put(f"full.arm-{s}.shoulder", "rotation", f, bone_rot[f"full.arm-{s}.shoulder"] + K_SH * (up - bone_rot[f"full.arm-{s}.upper"]))
            put(f"full.arm-{s}.fore", "rotation", f, bone_rot[f"full.arm-{s}.fore"] + ins * o["elbow"][s])
            put(f"full.arm-{s}.hand", "rotation", f, bone_rot[f"full.arm-{s}.hand"] - ins * 0.25 * o["elbow"][s])
            for fg in FING:
                for sg in SEGS:
                    n = f"full.arm-{s}.{fg}{sg}"
                    put(n, "rotation", f, o["curl"] * fist[n])
        # secondary lag chains
        dx, dy = disp(f, D_lag)
        chains = [("hair.lock.l", 3, +1, 0.0045, 0.004), ("hair.lock.r", 3, -1, 0.0045, 0.004),
                  ("hair.back.l", 2, +1, 0.004, 0.003), ("hair.back.r", 2, -1, 0.004, 0.003),
                  ("bangs.a", 2, +1, 0.0025, 0.0015), ("bangs.b", 2, 0, 0.0025, 0.0), ("bangs.c", 2, -1, 0.0025, 0.0015),
                  ("hem.ribbon.l", 3, +1, 0.004, 0.0025), ("hem.ribbon.r", 3, -1, 0.004, 0.0025)]
        for nm, k, out, kx, ky in chains:
            for j in range(1, k + 1):
                g = 1.0 + 0.4 * (j - 1)
                put(f"full.{nm}.s{j}", "rotation", f, g * (kx * dx + out * ky * dy))
        put("full.belt.id", "rotation", f, 0.006 * dx + 0.002 * dy)
    body = ""
    for (obj, prop), kf in tracks.items():
        ks = "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in kf)
        body += f'            <KeyedObject objectId="{obj}"><KeyedProperty property="{prop}">{ks}</KeyedProperty></KeyedObject>\n'
    return body, worst, log


def main():
    s = SCENE.read_text(encoding="utf-8")
    for name, (tid, aid, sid, _) in CLIPS.items():
        s = re.sub(rf'\n\s*<ViewModelPropertyTrigger name="{name}" id="{tid}"/>', "", s)
        s = re.sub(rf'\n\s*<ViewModelInstanceTrigger viewModelPropertyId="{tid}"/>', "", s)
        s = re.sub(rf'\n\s*<LinearAnimation name="full\.{name}".*?</LinearAnimation>', "", s, flags=re.S)
        s = re.sub(rf'\n\s*<AnimationState [^>]*id="{sid}">.*?</AnimationState>', "", s, flags=re.S)
        s = re.sub(rf'\n\s*<StateTransition stateToId="{sid}" duration="12">.*?</StateTransition>', "", s, flags=re.S)
    logs = {}
    for name, (tid, aid, sid, sy) in CLIPS.items():
        if name == "walk":
            dur = W_STEP * W_N + W_SETTLE; body, worst, log = bake(s, walk_frame, dur, 6)
        else:
            dur = R_CYC * R_N + R_SETTLE; body, worst, log = bake(s, run_frame, dur, 4)
        logs[name] = dict(dur=dur, worst_planted_err=worst, frames=log)
        anim = f'\n        <LinearAnimation name="full.{name}" loopValue="oneShot" duration="{dur}" fps="{FPS}" id="{aid}">\n{body}        </LinearAnimation>'
        m = re.search(r'<LinearAnimation name="full\.squat".*?</LinearAnimation>', s, re.S)
        s = s[:m.end()] + anim + s[m.end():]
        s = s.replace('<ViewModelPropertyTrigger name="squat" id="0:293"/>',
                      f'<ViewModelPropertyTrigger name="squat" id="0:293"/>\n        <ViewModelPropertyTrigger name="{name}" id="{tid}"/>', 1)
        s = s.replace('<ViewModelInstanceTrigger viewModelPropertyId="0:293"/>',
                      f'<ViewModelInstanceTrigger viewModelPropertyId="0:293"/>\n            <ViewModelInstanceTrigger viewModelPropertyId="{tid}"/>', 1)
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
        print(f"ROUND26 {name}: {dur} f ({dur / FPS:.2f} s), worst planted-ankle solve error {worst:.2e} px")
    SCENE.write_text(s, encoding="utf-8")
    if len(sys.argv) > 1:
        json.dump(logs, open(sys.argv[1], "w"))
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round26_gait" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round26_gait.py\n")


if __name__ == "__main__":
    main()
