#!/usr/bin/env python3
"""ROUND27 item 3 - secondary motion of the coat front chains (coat-X.front -> front.s1 -> hem).

Per clip and side, from the clip's own baked keys (forward kinematics over every frame):
  gravity  each joint counter-rotates a share (root 0.35, s1 0.30, hem 0.20) of the upper arm's world rotation away
           from rest: the top stays sewn to the sleeve, the free lower panel and the hem drape down when the arm lifts
           (segment world directions keep 65 / 35 / 15 % of the lift);
  inertia  three damped springs (one per segment, periods 20 / 23 / 26 f, zeta 0.32 -> lag + one visible overshoot)
           follow the attach point; the lag vector d = q - p, projected on the segment normal and divided by the
           cumulative length from the attach point, gives each segment's deviation phi_j (tip trails the motion,
           delay grows down the chain); a fast DROP of the attach point (d along the hang direction < 0) flares the
           panel outward instead of buckling it;
  shape    a counter-bend below a bend is halved (no S-shaped zig-zag on a 3-joint panel);
  limits   phi inward (toward the legs / shorts) >= -0.05 rad, outward <= +0.22 rad, per-segment |local| <= 0.18;
  idle     + gentle drift: 2 cycles over the 216 f loop, amplitude 0.003 / 0.005 / 0.007 rad, 0.6 rad phase step
           down the chain (ripple), springs run over two loops so the loop is seamless;
  one-shot clips fade the secondary part in over the first 4 f and out over the last 16 f (ends exactly at rest).
Local rotations: r_j = r0_j - GRAV_j*dAlpha + (phi_j - phi_{j-1}).  Keys every 2 f, linear.
Idempotent (strips its own KeyedObjects first)."""
from __future__ import annotations
import json, math, re, sys
import numpy as np
import round13_anim as A
import round10_layers as L10
import round27_common as C

SCENE = L10.PROJECT / "scene.rml"
REQ = ["full.idle", "full.walk", "full.run", "full.hop", "full.step", "full.squat", "full.wave", "full.cheer"]
GRAV = (0.35, 0.30, 0.20)   # counter-rotation share per joint: root/s1/hem world dirs keep 65 / 35 / 15 % of the arm's lift
T = (20.0, 23.0, 26.0)
ZETA = 0.32
GAIN = (0.9, 1.25, 1.6)
FLARE = 0.9
LIM_IN, LIM_OUT, LIM_LOC = -0.05, 0.22, 0.18
DRIFT = (0.003, 0.005, 0.007)
GRAV_MIN = 0.12          # other clips get the chain only if the upper arm leaves rest by more than this


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def chain_names(s):
    return [f"full.coat-{s}.front", f"full.coat-{s}.front.s1", f"full.coat-{s}.hem"]


def simulate(fk, anim, s, dur, loop):
    names = chain_names(s)
    h = fk.h
    r0 = [h[n]["r"] for n in names]
    Ls = [float(re.search(r'length="([-\d.]+)"', fk.raw[n]).group(1)) for n in names]
    Lc = np.cumsum(Ls)
    up = f"full.arm-{s}.upper"
    out = 1.0 if s == "l" else -1.0
    a0 = C.angle(fk.world(up))
    frames = range(0, dur + 1)
    P, dA = [], []
    for f in frames:
        Wu = fk.world(up, anim, f)
        Wf = Wu @ fk.local(names[0], None, 0)
        P.append(Wf[:2, 2].copy()); dA.append(wrap(C.angle(Wu) - a0))
    P = np.array(P); dA = np.array(dA)
    passes = 2 if loop else 1
    seq = np.concatenate([P] * passes) if loop else P
    q = [seq[0].copy() for _ in T]; v = [np.zeros(2) for _ in T]
    D = np.zeros((len(seq), 3, 2))
    for i, p in enumerate(seq):
        for j, Tj in enumerate(T):
            w = 2 * math.pi / Tj
            acc = w * w * (p - q[j]) - 2 * ZETA * w * v[j]
            v[j] = v[j] + acc; q[j] = q[j] + v[j]
            D[i, j] = q[j] - p
    D = D[-len(P):]
    res = []
    for k, f in enumerate(frames):
        th0 = C.angle(fk.world(up, anim, f)) + r0[0] - GRAV[0] * dA[k]    # hang direction of the chain root
        phis = []
        for j in range(3):
            th = th0 + sum(r0[1:j + 1]) - sum(GRAV[1:j + 1]) * dA[k]
            n = np.array([-math.sin(th), math.cos(th)]); hd = np.array([math.cos(th), math.sin(th)])
            d = D[k, j]
            phi = GAIN[j] * float(d @ n) / Lc[j]                          # tip trails: rotating by phi moves it phi*L along n
            along = float(d @ hd)
            if along < 0:
                phi += out * FLARE * (-along) / Lc[j]
            if anim == "full.idle":
                phi += out * DRIFT[j] * math.sin(2 * math.pi * 2 * f / dur - 0.6 * j)
            lo, hi = (LIM_IN, LIM_OUT) if out > 0 else (-LIM_OUT, -LIM_IN)
            phis.append(min(max(phi, lo), hi))
        if not loop:
            env = min(1.0, f / 4.0) * min(1.0, max(0.0, (dur - f) / 16.0))
            env = env * env * (3 - 2 * env)
            phis = [p * env for p in phis]
        loc = [phis[0]]
        for j in (1, 2):                                   # no zig-zag: a counter-bend below a bend is halved
            inc = phis[j] - phis[j - 1]
            if inc * loc[-1] < 0:
                inc *= 0.5
            loc.append(max(-LIM_LOC, min(LIM_LOC, inc)))
        res.append(dict(f=f, grav=[-g * dA[k] for g in GRAV], loc=loc, phi=phis, attach=P[k].tolist()))
    return res, r0


def main():
    s = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(s)
    own = {ids[n] for side in "lr" for n in chain_names(side)}
    s = re.sub(r'\s*<KeyedObject objectId="(0:\d+)"><KeyedProperty property="rotation">[^<]*(?:<KeyFrameDouble [^>]*/>)*</KeyedProperty></KeyedObject>',
               lambda m: "" if m.group(1) in own else m.group(0), s)
    fk = C.FK(s)
    fk.raw = {m.group(1): m.group(0) for m in re.finditer(r'<RootBone name="([^"]+)"[^>]*>', s)}
    loops = dict(re.findall(r'<LinearAnimation name="([^"]+)" loopValue="(\w+)"', s))
    clips = list(REQ)
    for a, (dur, tr) in fk.an.items():
        if a in clips or a == "rest" or a == "full.idle-blink":
            continue
        mx = 0.0
        for side in "lr":
            k = tr.get(ids[f"full.arm-{side}.upper"], {}).get("rotation", [])
            r = fk.h[f"full.arm-{side}.upper"]["r"]
            mx = max([mx] + [abs(x[1] - r) for x in k])
        if mx > GRAV_MIN:
            clips.append(a)
    log = {}
    for a in clips:
        dur = fk.an[a][0]
        body = ""
        for side in "lr":
            res, r0 = simulate(fk, a, side, dur, loops.get(a) == "loop")
            log.setdefault(a, {})[side] = res
            fr = list(range(0, dur + 1, 2)) + ([dur] if dur % 2 else [])
            names = chain_names(side)
            for j, n in enumerate(names):
                vals = [(f, r0[j] + res[f]["grav"][j] + res[f]["loc"][j]) for f in fr]
                body += A.linear_track(ids[n], "rotation", vals)
        s = A.add_to_anim(s, a, body)
    SCENE.write_text(s, encoding="utf-8")
    print("ROUND27 coat motion:", ", ".join(clips))
    if len(sys.argv) > 1:
        json.dump(log, open(sys.argv[1], "w"))
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round27_coat_motion" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round27_coat_motion.py\n")


if __name__ == "__main__":
    main()
