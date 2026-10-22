#!/usr/bin/env python3
"""ROUND21 — arm FK chains + wave coordination.

Diagnosis (R21): arm bones were FLAT siblings under full.arm-{l,r}.rig
(upper / fore / hand each keyed in absolute rig space), and the rigs were
children of full.root, not of the torso. Linear interpolation of independent
absolute x/y/rotation tracks opens elbow (<=5.5 px) and wrist (<=20 px) gaps
between keys, hands wobble against the forearm, and shoulders ignore torso
lean. R20's fore scaleY squeezed forearm *width* (bone axis = arm length), not
length.

Fix:
  1. nest fore under upper and hand under fore (rest world transforms kept, so
     skin tendons stay valid); re-express every clip's keys in parent-local
     space at the union of key frames (identical world pose on every key).
  2. clips where torso rotates: bake arm rig x/y/rotation to follow the torso.
  3. full.wave: drop fore scaleY, add follow-through (fore +3f, hand +5f lag),
     torso counter-lean, shoulder lift, head tilt.
Idempotent: refuses to run twice (marker).
"""
from __future__ import annotations
import math, re
import round10_layers as L10
import round13_anim as A
import round8_scene as R8

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!-- ROUND21 arm-fk -->"
EASE = '<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>'
TORSO = (480.0, 660.0)


def M(x, y, r, sy=1.0):
    c, s = math.cos(r), math.sin(r)
    return [c, s, -s * sy, c * sy, x, y]  # a b c d tx ty  (x'=a x + c y + tx)


def mul(p, q):
    a, b, c, d, tx, ty = p
    return [a*q[0]+c*q[1], b*q[0]+d*q[1], a*q[2]+c*q[3], b*q[2]+d*q[3],
            a*q[4]+c*q[5]+tx, b*q[4]+d*q[5]+ty]


def inv(p):
    a, b, c, d, tx, ty = p
    det = a*d - b*c
    ia, ib, ic, id_ = d/det, -b/det, -c/det, a/det
    return [ia, ib, ic, id_, -(ia*tx+ic*ty), -(ib*tx+id_*ty)]


def dec(m):
    return m[4], m[5], math.atan2(m[1], m[0])


def unwrap(vals):
    out = []
    for v in vals:
        if out:
            while v - out[-1] > math.pi: v -= 2*math.pi
            while v - out[-1] < -math.pi: v += 2*math.pi
        out.append(v)
    return out


def strip(scene, anim, oid, prop):
    a, b = R8.find_elem(scene, "LinearAnimation", anim)
    body = scene[a:b]
    def repl(m):
        blk = re.sub(rf'\n?\s*<KeyedProperty property="{prop}">.*?</KeyedProperty>', "", m.group(0), flags=re.S)
        return blk if "<KeyedProperty" in blk else ""
    body = re.sub(rf'\n?\s*<KeyedObject objectId="{re.escape(oid)}">.*?</KeyedObject>', repl, body, flags=re.S)
    return scene[:a] + body + scene[b:]


def track(oid, prop, fv):
    kf = "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="cubic">{EASE}</KeyFrameDouble>' for f, v in fv)
    return f'<KeyedObject objectId="{oid}"><KeyedProperty property="{prop}">{kf}</KeyedProperty></KeyedObject>'


def bone_attrs(scene, name):
    m = re.search(rf'<RootBone name="{re.escape(name)}" x="([-\d.]+)" y="([-\d.]+)" rotation="([-\d.]+)"', scene)
    return float(m.group(1)), float(m.group(2)), float(m.group(3))


def set_bone_attrs(scene, name, x, y, r):
    return re.sub(rf'(<RootBone name="{re.escape(name)}") x="[-\d.]+" y="[-\d.]+" rotation="[-\d.]+"',
                  rf'\1 x="{x:.4f}" y="{y:.4f}" rotation="{r:.6f}"', scene, count=1)


def nest(scene, side):
    up, fo, ha = (f"full.arm-{side}.{p}" for p in ("upper", "fore", "hand"))
    # cut hand (with finger children) and fore (self-closing)
    a, b = R8.find_elem(scene, "RootBone", ha); hand_xml = scene[a:b]; scene = scene[:a] + scene[b:]
    a, b = R8.find_elem(scene, "RootBone", fo); fore_xml = scene[a:b]; scene = scene[:a] + scene[b:]
    fore_xml = fore_xml[:-2] + ">" + hand_xml + "</RootBone>"
    a, b = R8.find_elem(scene, "RootBone", up); up_xml = scene[a:b]
    up_xml = up_xml[:-2] + ">" + fore_xml + "</RootBone>"
    return scene[:a] + up_xml + scene[b:]


def main():
    scene = SCENE.read_text(encoding="utf-8")
    if MARK in scene:
        print("ROUND21 arm-fk already applied"); return
    ids = A.ids_by_name(scene)
    # ---- wave: drop R20 fore scaleY before converting
    scene = strip(scene, "full.wave", ids["full.arm-r.fore"], "scaleY")
    anims = A.animations(scene)
    report = {}
    for side in ("l", "r"):
        up, fo, ha = (f"full.arm-{side}.{p}" for p in ("upper", "fore", "hand"))
        rest = {n: bone_attrs(scene, n) for n in (up, fo, ha)}
        U0 = M(0, 0, rest[up][2])  # upper rest at rig origin (x=y=0 asserted)
        assert abs(rest[up][0]) < 1e-6 and abs(rest[up][1]) < 1e-6
        F0 = M(*rest[fo]); H0 = M(*rest[ha])
        lf = dec(mul(inv(U0), F0)); lh = dec(mul(inv(F0), H0))
        new_tracks = {}
        for an, (dur, tr) in anims.items():
            iu, ifo, iha = ids[up], ids[fo], ids[ha]
            tu, tf, th = tr.get(iu, {}), tr.get(ifo, {}), tr.get(iha, {})
            if not tf and not th:
                continue  # fore/hand unkeyed: they now follow upper (correct FK)
            frames = sorted({k[0] for t in (tu, tf, th) for v in t.values() for k in v})
            def g(t, p, f, dv):
                k = t.get(p); return dv if not k else A.eval_track(k, f)
            fl, hl = [], []
            for f in frames:
                U = M(0, 0, g(tu, "rotation", f, rest[up][2]))
                F = M(g(tf, "x", f, rest[fo][0]), g(tf, "y", f, rest[fo][1]), g(tf, "rotation", f, rest[fo][2]))
                H = M(g(th, "x", f, rest[ha][0]), g(th, "y", f, rest[ha][1]), g(th, "rotation", f, rest[ha][2]))
                fl.append(dec(mul(inv(U), F))); hl.append(dec(mul(inv(F), H)))
            new_tracks[an] = (frames, fl, hl, bool(tf), bool(th))
        # rewrite scene keys
        for an, (frames, fl, hl, kf, kh) in new_tracks.items():
            for p in ("x", "y", "rotation"):
                scene = strip(scene, an, ids[fo], p); scene = strip(scene, an, ids[ha], p)
            fr = unwrap([v[2] for v in fl]); hr = unwrap([v[2] for v in hl])
            xml = ""
            if kf or kh:
                xml += track(ids[fo], "x", [(f, v[0]) for f, v in zip(frames, fl)])
                xml += track(ids[fo], "y", [(f, v[1]) for f, v in zip(frames, fl)])
                xml += track(ids[fo], "rotation", list(zip(frames, fr)))
                xml += track(ids[ha], "x", [(f, v[0]) for f, v in zip(frames, hl)])
                xml += track(ids[ha], "y", [(f, v[1]) for f, v in zip(frames, hl)])
                xml += track(ids[ha], "rotation", list(zip(frames, hr)))
            scene = A.add_to_anim(scene, an, xml)
        scene = nest(scene, side)
        scene = set_bone_attrs(scene, fo, *lf)
        scene = set_bone_attrs(scene, ha, *lh)
        report[side] = (lf, lh, sorted(new_tracks))
    # ---- wave coordination (operate on fresh parse)
    ids = A.ids_by_name(scene)
    anims = A.animations(scene)
    dur, tr = anims["full.wave"]
    def lag(oid, prop, d):
        keys = tr[oid][prop]
        out = [(keys[0][0], keys[0][1])]
        for f, v, _ in keys[1:-1]:
            out.append((min(f + d, dur - 4), v))
        out.append((keys[-1][0], keys[-1][1]))
        # dedupe frames monotonic
        res = []
        for f, v in out:
            if res and f <= res[-1][0]: f = res[-1][0] + 1
            res.append((f, v))
        return res
    fo, ha = ids["full.arm-r.fore"], ids["full.arm-r.hand"]
    newf = {p: lag(fo, p, 3) for p in ("x", "y", "rotation")}
    newh = {p: lag(ha, p, 5) for p in ("x", "y", "rotation")}
    for p in ("x", "y", "rotation"):
        scene = strip(scene, "full.wave", fo, p); scene = strip(scene, "full.wave", ha, p)
    xml = "".join(track(fo, p, v) for p, v in newf.items()) + "".join(track(ha, p, v) for p, v in newh.items())
    # torso counter-lean / head tilt / shoulder lift (rig y follows via bake below)
    WAVE_TORSO = [(0, 0.0), (24, -0.022), (52, -0.026), (78, -0.022), (108, 0.0)]
    WAVE_HEAD = [(0, 0.0), (28, 0.035), (54, 0.045), (80, 0.035), (108, 0.0)]
    WAVE_LIFT = {0: 0.0, 24: -5.0, 52: -6.0, 78: -5.0, 108: 0.0}
    xml += track(ids["full.torso"], "rotation", WAVE_TORSO)
    xml += track(ids["full.head"], "rotation", WAVE_HEAD)
    scene = A.add_to_anim(scene, "full.wave", xml)
    # ---- bake arm rigs to follow torso rotation (all clips with torso keys, rig unkeyed props)
    anims = A.animations(scene)
    rigs = {s: bone_attrs(scene, f"full.arm-{s}.rig") for s in ("l", "r")}
    baked = []
    for an, (dur, tr) in anims.items():
        tt = tr.get(ids["full.torso"], {}).get("rotation")
        for s in ("l", "r"):
            rid = ids[f"full.arm-{s}.rig"]
            rk = tr.get(rid, {})
            if not tt and not (an == "full.wave" and s == "r"):
                continue
            frames = sorted({k[0] for k in (tt or [])} | {k[0] for v in rk.values() for k in v} |
                            (set(WAVE_LIFT) if an == "full.wave" and s == "r" else set()))
            rx0, ry0, _ = rigs[s]
            xs, ys, rs = [], [], []
            for f in frames:
                th = A.eval_track(tt, f) if tt else 0.0
                bx = A.eval_track(rk["x"], f) if "x" in rk else rx0
                by = (A.eval_track(rk["y"], f) if "y" in rk else ry0)
                if an == "full.wave" and s == "r":
                    by += A.eval_track([(k, v, "cubic") for k, v in sorted(WAVE_LIFT.items())], f)
                dx, dy = bx - TORSO[0], by - TORSO[1]
                c, si = math.cos(th), math.sin(th)
                xs.append((f, TORSO[0] + c*dx - si*dy)); ys.append((f, TORSO[1] + si*dx + c*dy)); rs.append((f, th))
            for p in ("x", "y", "rotation"):
                scene = strip(scene, an, rid, p)
            scene = A.add_to_anim(scene, an, track(rid, "x", xs) + track(rid, "y", ys) + track(rid, "rotation", rs))
            baked.append((an, s))
    # ---- torso-locked statics (shoulder skin / sleeve stump / coat shoulder) live under
    # full.root: bake them to follow torso rotation too, else the arm (now following the
    # torso) separates from them.
    STATICS = [f"full.arm-{s}.{p}.static" for s in ("l", "r")
               for p in ("shoulder-skin", "sleeve-stump", "coat-shoulder", "coat-shoulder.dark")]
    ids = A.ids_by_name(scene)
    anims = A.animations(scene)
    for an, (dur, tr) in anims.items():
        tt = tr.get(ids["full.torso"], {}).get("rotation")
        if not tt:
            continue
        frames = sorted({k[0] for k in tt})
        for nm in STATICS:
            m = re.search(rf'<Image name="{re.escape(nm)}"[^>]*?x="([-\d.]+)" y="([-\d.]+)"', scene)
            px, py = float(m.group(1)), float(m.group(2))
            xs, ys, rs = [], [], []
            for f in frames:
                th = A.eval_track(tt, f); c, si = math.cos(th), math.sin(th)
                dx, dy = px - TORSO[0], py - TORSO[1]
                xs.append((f, TORSO[0] + c*dx - si*dy)); ys.append((f, TORSO[1] + si*dx + c*dy)); rs.append((f, th))
            oid = ids[nm]
            for p in ("x", "y", "rotation"):
                scene = strip(scene, an, oid, p)
            scene = A.add_to_anim(scene, an, track(oid, "x", xs) + track(oid, "y", ys) + track(oid, "rotation", rs))
    scene = scene.replace("    <!-- ROUND7-FULL-DECOMPOSE assets -->\n", "    " + MARK + "\n    <!-- ROUND7-FULL-DECOMPOSE assets -->\n", 1)
    assert MARK in scene
    SCENE.write_text(scene, encoding="utf-8")
    build = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = build.read_text()
    if "round21_arm_fk" not in bt:
        build.write_text(bt.rstrip() + "\npython3 round21_arm_fk.py\n")
    for s, (lf, lh, an) in report.items():
        print(s, "fore local", [round(v, 4) for v in lf], "hand local", [round(v, 4) for v in lh], "clips", len(an))
    print("rig torso-follow baked:", baked)


if __name__ == "__main__":
    main()
