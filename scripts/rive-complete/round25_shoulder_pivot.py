#!/usr/bin/env python3
"""ROUND25a - move the upper-arm pivot onto the glenohumeral centre (centre of the shoulder-cap dome).

Measured on the rest render (artboard px): the deltoid dome's top is at y~238 (x552-571), the lateral arm edge at
x~590 (y~280) and the medial (armpit) edge at x~552, so the humeral head centre is G=(568,268) (mirrored for arm-l).
The R21 pivot J=(592.8,300.8) sat on the LATERAL-LOWER surface of the deltoid, 41 px off G.  Rotating a ~95 deg wave
about J instead of G translates the whole upper arm by |I-R|*|J-G| ~ 60 px down/out, so the raised arm emerged
*below* the shoulder cap and the cap folded over it (user screenshot R23/R24 wave f052).
Rest is pixel-identical (bone and every upper-arm tendon bind move by the same delta, elbow world point unchanged).
Keys are retargeted like R21: the authored elbow/hand joint angles are kept and the upper arm is swung about G so
the wrist keeps its direction from the shoulder (hand world rotation kept); 2-bone IK is blended in only where that
swing leaves >2 px reach error (clap hands still meet).
Idempotent via MARK."""
from __future__ import annotations
import json, math, re
import round10_layers as L10
import round13_anim as A
import round21_arm_fk as FK
import round21_arm_pivot as P21

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!-- ROUND25 shoulder-pivot -->"
G = {"r": (-74.8, -2.8), "l": (74.8, -2.8)}   # rig-local; rig rest (642.8|317.8, 270.8) -> world (568|392, 268)
REP = {}


def main():
    scene = SCENE.read_text(encoding="utf-8")
    assert P21.MARK in scene
    if MARK in scene:
        print("already applied"); return
    ids = A.ids_by_name(scene)
    for side, S in G.items():
        up, fo, ha = (f"full.arm-{side}.{p}" for p in ("upper", "fore", "hand"))
        ux, uy, ur = FK.bone_attrs(scene, up); fx, fy, fr = FK.bone_attrs(scene, fo); hx, hy, hr = FK.bone_attrs(scene, ha)
        U_old = FK.M(ux, uy, ur); F_old = FK.mul(U_old, FK.M(fx, fy, fr)); H_old = FK.mul(F_old, FK.M(hx, hy, hr))
        U_new = FK.M(S[0], S[1], ur)
        fl = FK.dec(FK.mul(FK.inv(U_new), F_old))          # fore keeps its world rest transform
        scene = FK.set_bone_attrs(scene, up, S[0], S[1], ur)
        scene = FK.set_bone_attrs(scene, fo, fl[0], fl[1], fl[2])
        E0 = (F_old[4], F_old[5]); W0 = (H_old[4], H_old[5])
        a = math.dist(S, E0); b = math.dist(E0, W0)
        alpha0 = math.atan2(E0[1] - S[1], E0[0] - S[0]); beta0 = math.atan2(W0[1] - E0[1], W0[0] - E0[0])
        dd = lambda x, y: (x - y + math.pi) % (2 * math.pi) - math.pi
        for an, (dur, tr) in A.animations(scene).items():
            tu, tf, th = tr.get(ids[up], {}), tr.get(ids[fo], {}), tr.get(ids[ha], {})
            if not tu and not tf and not th:
                continue
            frames = sorted({k[0] for t in (tu, tf, th) for v in t.values() for k in v})
            g = lambda t, p, f, dv: dv if not t.get(p) else A.eval_track(t[p], f)
            ur_k, fr_k, hr_k, err = [], [], [], []
            for f in frames:
                u = g(tu, "rotation", f, ur); frl = g(tf, "rotation", f, fr); hrl = g(th, "rotation", f, hr)
                Uo = FK.M(ux, uy, u); Fo = FK.mul(Uo, FK.M(fx, fy, frl)); Ho = FK.mul(Fo, FK.M(hx, hy, hrl))
                T = (Ho[4], Ho[5]); Eo = (Fo[4], Fo[5]); hw = math.atan2(Ho[1], Ho[0])
                # swing: keep the authored elbow/hand joint angles, rotate the upper arm about G so the wrist keeps
                # its direction from the shoulder (same rhythm, same elbow bend); blend in 2-bone IK only where the
                # swing leaves a real reach error (as R21), so clap hands still meet.
                Un = FK.M(S[0], S[1], u); Fn = FK.mul(Un, FK.M(fl[0], fl[1], frl)); Hn = FK.mul(Fn, FK.M(hx, hy, hrl))
                delta = dd(math.atan2(T[1] - S[1], T[0] - S[0]), math.atan2(Hn[5] - S[1], Hn[4] - S[0]))
                un, frn = u + delta, frl
                Un = FK.M(S[0], S[1], un); Fn = FK.mul(Un, FK.M(fl[0], fl[1], frn)); Hn = FK.mul(Fn, FK.M(hx, hy, hrl))
                e0 = math.dist(T, (Hn[4], Hn[5]))
                wgt = max(0.0, min(1.0, (e0 - 2.0) / 6.0)); wgt = wgt * wgt * (3 - 2 * wgt)
                if wgt > 0 and (tf or th):
                    d = min(max(math.dist(S, T), abs(a - b) + 1e-3), a + b - 1e-3)
                    base = math.atan2(T[1] - S[1], T[0] - S[0]); off = math.acos((a * a + d * d - b * b) / (2 * a * d))
                    ua = min((base + off, base - off), key=lambda q: math.dist((S[0] + a * math.cos(q), S[1] + a * math.sin(q)), (Fn[4], Fn[5])))
                    Ew = (S[0] + a * math.cos(ua), S[1] + a * math.sin(ua))
                    fa = math.atan2(T[1] - Ew[1], T[0] - Ew[0])
                    un_ik = ur + dd(ua, alpha0); fw = math.atan2(F_old[1], F_old[0]) + dd(fa, beta0)
                    un = un + wgt * dd(un_ik, un); frn = frn + wgt * dd(dd(fw - un_ik, 0), frn)
                    Un = FK.M(S[0], S[1], un); Fn = FK.mul(Un, FK.M(fl[0], fl[1], frn))
                hrn = dd(hw - math.atan2(Fn[1], Fn[0]), 0) if (tf or th) else hrl
                Hn = FK.mul(Fn, FK.M(hx, hy, hrn))
                err.append(math.dist(T, (Hn[4], Hn[5])))
                ur_k.append(un); fr_k.append(frn); hr_k.append(hrn)
            for o, p in ((ids[up], "rotation"), (ids[fo], "rotation"), (ids[ha], "rotation")):
                scene = FK.strip(scene, an, o, p)
            xml = FK.track(ids[up], "rotation", list(zip(frames, FK.unwrap(ur_k))))
            if tf or th:
                xml += FK.track(ids[fo], "rotation", list(zip(frames, FK.unwrap(fr_k)))) + FK.track(ids[ha], "rotation", list(zip(frames, FK.unwrap(hr_k))))
            scene = A.add_to_anim(scene, an, xml)
            REP[f"{side}:{an}"] = round(max(err), 2)
        scene = re.sub(rf'(<Tendon boneId="{re.escape(ids[up])}"[^>]*?tx=")([-\d.]+)(" ty=")([-\d.]+)(")',
                       lambda q: f'{q.group(1)}{float(q.group(2)) + S[0] - ux:.4f}{q.group(3)}{float(q.group(4)) + S[1] - uy:.4f}{q.group(5)}', scene)
        print(side, "shoulder pivot moved", round(math.hypot(S[0] - ux, S[1] - uy), 1), "px; upper len", round(a, 1))
    scene = scene.replace(P21.MARK, P21.MARK + "\n    " + MARK, 1)
    SCENE.write_text(scene, encoding="utf-8")
    (L10.ROOT / "scripts/rive-complete/round13/shoulder-pivot-r25.json").write_text(json.dumps(REP, indent=1))
    print("max wrist error px", max(REP.values()))
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round25_shoulder_pivot" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round25_shoulder_pivot.py\n")


if __name__ == "__main__":
    main()
