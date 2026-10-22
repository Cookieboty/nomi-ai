#!/usr/bin/env python3
"""ROUND21 — move arm pivots onto the anatomical joints of the mother image.

Measured (rig px; x1.18 = mother px): old shoulder pivot (0,0) sits ~58 px
OUTSIDE the arm (empty space right of the deltoid); old elbow pivot
(+-25.4,215.5) sits ~56 px outside the sleeve silhouette (sleeve x-range at
y=215 is -75.6..13.2, centre -31). Wrist pivot was fine (~5 px).
New pivots: shoulder (-50,30), elbow (-30,212) (mirrored for arm-l).
Rest world transforms of the pieces are unchanged: bones and their skin
tendons move by the same delta, so rest is pixel-identical. Keyed rotations
are IK-retargeted per key so every key keeps its wrist world position and\nhand world rotation (clap hands still meet); fore/hand position keys dropped\n(rigid FK lengths).
Requires round21_arm_fk.py (chained bones). Idempotent via marker.
"""
from __future__ import annotations
import math, re
import round10_layers as L10
import round13_anim as A
import round21_arm_fk as FK

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!-- ROUND21 arm-pivot -->"
REACH = {}
JOINTS = {"r": ((-50.0, 30.0), (-30.0, 212.0)), "l": ((50.0, 30.0), (30.0, 212.0))}


def rebase(scene, oid, prop, old_rest, new_rest):
    def fix_anim(m):
        body = m.group(0)
        def fix_obj(k):
            blk = k.group(0)
            def fix_prop(p):
                if p.group(1) != prop: return p.group(0)
                return re.sub(r'(<KeyFrameDouble value=")([-\d.eE+]+)(")',
                              lambda q: f'{q.group(1)}{float(q.group(2)) - old_rest + new_rest:.6f}{q.group(3)}', p.group(0))
            return re.sub(r'<KeyedProperty property="(\w+)">.*?</KeyedProperty>', fix_prop, blk, flags=re.S)
        return re.sub(rf'<KeyedObject objectId="{re.escape(oid)}">.*?</KeyedObject>', fix_obj, body, flags=re.S)
    return re.sub(r'<LinearAnimation\b.*?</LinearAnimation>', fix_anim, scene, flags=re.S)


def main():
    scene = SCENE.read_text(encoding="utf-8")
    assert FK.MARK in scene, "run round21_arm_fk.py first"
    if MARK in scene:
        print("already applied"); return
    ids = A.ids_by_name(scene)
    for side, (S, E) in JOINTS.items():
        up, fo, ha = (f"full.arm-{side}.{p}" for p in ("upper", "fore", "hand"))
        ux, uy, ur = FK.bone_attrs(scene, up); fx, fy, fr = FK.bone_attrs(scene, fo); hx, hy, hr = FK.bone_attrs(scene, ha)
        U_old = FK.M(ux, uy, ur); F_old = FK.mul(U_old, FK.M(fx, fy, fr)); H_w = FK.mul(F_old, FK.M(hx, hy, hr))
        old_elbow = (F_old[4], F_old[5])
        U_new = FK.M(S[0], S[1], ur)
        fl = FK.dec(FK.mul(FK.inv(U_new), FK.M(E[0], E[1], math.atan2(F_old[1], F_old[0]))))
        F_new = FK.mul(U_new, FK.M(fl[0], fl[1], fr))
        hl = FK.dec(FK.mul(FK.inv(F_new), H_w))
        scene = FK.set_bone_attrs(scene, up, S[0], S[1], ur)
        scene = FK.set_bone_attrs(scene, fo, fl[0], fl[1], fr)
        scene = FK.set_bone_attrs(scene, ha, hl[0], hl[1], hl[2])
        # IK retarget: keep every key's wrist world position + hand world rotation
        S0 = (S[0], S[1]); E0 = (E[0], E[1]); W0 = (H_w[4], H_w[5])
        a = math.dist(S0, E0); b = math.dist(E0, W0)
        alpha0 = math.atan2(E0[1]-S0[1], E0[0]-S0[0]); beta0 = math.atan2(W0[1]-E0[1], W0[0]-E0[0])
        frw0 = math.atan2(F_new[1], F_new[0])
        anims = A.animations(scene)
        for an, (dur, tr) in anims.items():
            tu, tf, th = tr.get(ids[up], {}), tr.get(ids[fo], {}), tr.get(ids[ha], {})
            if not tf and not th:
                continue
            frames = sorted({k[0] for t in (tu, tf, th) for v in t.values() for k in v})
            g = lambda t, p, f, dv: dv if not t.get(p) else A.eval_track(t[p], f)
            ur_k, fr_k, hr_k = [], [], []
            reach_err = []
            for f in frames:
                Uo = FK.M(ux, uy, g(tu, "rotation", f, ur))
                Fo = FK.mul(Uo, FK.M(g(tf, "x", f, fx), g(tf, "y", f, fy), g(tf, "rotation", f, fr)))
                Ho = FK.mul(Fo, FK.M(g(th, "x", f, hx), g(th, "y", f, hy), g(th, "rotation", f, hr)))
                T = (Ho[4], Ho[5]); Eold = (Fo[4], Fo[5]); hw = math.atan2(Ho[1], Ho[0])
                # keep old elbow bend (fore local rotation); swing the whole arm about the
                # new shoulder so the wrist keeps its old direction from the shoulder.
                urk0 = g(tu, "rotation", f, ur); frl = g(tf, "rotation", f, fr); hrl = g(th, "rotation", f, hr)
                Un = FK.M(S0[0], S0[1], urk0); Fn = FK.mul(Un, FK.M(fl[0], fl[1], frl)); Hn = FK.mul(Fn, FK.M(hl[0], hl[1], hrl))
                delta = math.atan2(T[1]-S0[1], T[0]-S0[0]) - math.atan2(Hn[5]-S0[1], Hn[4]-S0[0])
                delta = (delta + math.pi) % (2*math.pi) - math.pi
                if an == "full.wave":
                    delta = 0.0  # wave: keep authored joint angles (raised ~90 deg wave pose)
                urk = urk0 + delta
                frw = urk + frl
                err = abs(math.dist(S0, T) - math.dist(S0, (Hn[4], Hn[5])))
                # reach fix: 2-bone IK (branch nearest the swung elbow), blended in only when
                # the swing leaves a real reach error (IK is ill-conditioned near full extension).
                wgt = max(0.0, min(1.0, (err - 2.0) / 6.0)); wgt = wgt * wgt * (3 - 2 * wgt)
                if an == "full.wave":
                    wgt = 0.0  # wave: keep the authored ~90 deg elbow bend (old wrist was only reachable via the external pivots)
                if wgt > 0:
                    d = min(max(math.dist(S0, T), abs(a-b)+1e-3), a+b-1e-3)
                    base = math.atan2(T[1]-S0[1], T[0]-S0[0]); off = math.acos((a*a+d*d-b*b)/(2*a*d))
                    Esw = (S0[0] + a*math.cos(urk - ur + alpha0), S0[1] + a*math.sin(urk - ur + alpha0))
                    ua = min((base + off, base - off), key=lambda u: math.dist((S0[0]+a*math.cos(u), S0[1]+a*math.sin(u)), Esw))
                    Ew = (S0[0]+a*math.cos(ua), S0[1]+a*math.sin(ua))
                    fa = math.atan2(T[1]-Ew[1], T[0]-Ew[0])
                    urk_ik = ur + (ua - alpha0); frw_ik = frw0 + (fa - beta0); frl_ik = frw_ik - urk_ik
                    dd = lambda x, y: (x - y + math.pi) % (2*math.pi) - math.pi
                    urk = urk + wgt * dd(urk_ik, urk); frl = frl + wgt * dd(frl_ik, frl)
                    frw = urk + frl
                    Un = FK.M(S0[0], S0[1], urk); Fn = FK.mul(Un, FK.M(fl[0], fl[1], frl)); Hn = FK.mul(Fn, FK.M(hl[0], hl[1], 0))
                    err = math.dist(T, (Hn[4], Hn[5]))
                reach_err.append(err)
                ur_k.append(urk); fr_k.append(frl); hr_k.append(hw - frw)
            for o, p in ((ids[up], "rotation"), (ids[fo], "x"), (ids[fo], "y"), (ids[fo], "rotation"), (ids[ha], "x"), (ids[ha], "y"), (ids[ha], "rotation")):
                scene = FK.strip(scene, an, o, p)
            xml = (FK.track(ids[up], "rotation", list(zip(frames, FK.unwrap(ur_k)))) +
                   FK.track(ids[fo], "rotation", list(zip(frames, FK.unwrap(fr_k)))) +
                   FK.track(ids[ha], "rotation", list(zip(frames, FK.unwrap(hr_k)))))
            scene = A.add_to_anim(scene, an, xml)
            REACH[(side, an)] = max(reach_err)
        # tendons: shift bind translation by the same delta
        def shift(bid, dx, dy):
            nonlocal scene
            scene = re.sub(rf'(<Tendon boneId="{re.escape(bid)}"[^>]*?tx=")([-\d.]+)(" ty=")([-\d.]+)(")',
                           lambda q: f'{q.group(1)}{float(q.group(2)) + dx:.4f}{q.group(3)}{float(q.group(4)) + dy:.4f}{q.group(5)}', scene)
        shift(ids[up], S[0] - ux, S[1] - uy)
        shift(ids[fo], E[0] - old_elbow[0], E[1] - old_elbow[1])
        print(side, "shoulder moved", round(math.hypot(S[0]-ux, S[1]-uy), 1), "elbow moved",
              round(math.hypot(E[0]-old_elbow[0], E[1]-old_elbow[1]), 1), "fore local", [round(v, 3) for v in fl], "hand local", [round(v, 3) for v in hl])
    import json; (L10.ROOT / "scripts/rive-complete/round13/arm-pivot-r21.json").write_text(json.dumps({f"{k[0]}:{k[1]}": round(v, 2) for k, v in REACH.items()}, indent=1))
    print("max wrist reach error px", round(max(REACH.values()), 2))
    scene = scene.replace(FK.MARK, FK.MARK + "\n    " + MARK, 1)
    SCENE.write_text(scene, encoding="utf-8")
    build = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = build.read_text()
    if "round21_arm_pivot" not in bt:
        build.write_text(bt.rstrip() + "\npython3 round21_arm_pivot.py\n")


if __name__ == "__main__":
    main()
