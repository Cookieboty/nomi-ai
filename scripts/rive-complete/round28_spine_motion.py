#!/usr/bin/env python3
"""ROUND28 item 3 - sectional trunk motion on the new chest bone (full.spine) for idle / walk / run / hop / squat /
step / cheer.

Chest local keys (rotation sp, scaleY ss about the chest joint at rest world y 440) on top of each clip's own
pelvis / lumbar (full.torso) keys, computed from the clip's baked motion (FK) every 2 f:
  walk/run  chest counter-roll  sp = -0.45 * pelvis roll   (shoulder line tilts against the dropping hip, on top of
            the lumbar -0.6x; chest world ~ -1.05x pelvis) ; run: ss = 1 - 0.008 * stance dip (front-view lean hint)
  hop/squat follow-through of the lumbar tilt  sp = 0.5 * torso_rot(f - 4) ; crouch ss = 1 - 0.03*clip(dy/100,-0.4,1)
            (pose drop dy: squat 100 px -> chest 3 % shorter = front view of the trunk flexing forward; hop rise -> 1.2 % taller)
  step      lateral flexion toward the weight shift sp = 0.0015 * pose.x (<= 0.010 rad)
  cheer     chest lifts with the arms  ss = 1 + 0.012 * raise (mean upper-arm lift / 0.4 rad), sp = 0.5*torso(f-4)
  idle      breathing: ss = 1 + 0.0035 * b(f) (b = the clip's own pose.scaleY breath normalised), sp = 0.35 * torso(f - 6)
            (loop-wrapped -> seamless)
Head keeps its world tilt: head.rotation -= 0.7 * sp (gaze stabilisation; neck is on the chest since R28b).
Arm rigs (children of full.root, not of the trunk) follow the chest rigidly: rig' = C_new * C_base^-1 * rig, C = chest
in root space; C_base = the clip's old chest when the clip already keys the rigs to the trunk (idle/hop/squat/step),
the REST chest when it does not (walk/run - their R26 lumbar counter-roll left the shoulders behind).
One-shot clips fade the added part out over the last 8 f (end exactly on the old pose).  Run once (MARK)."""
from __future__ import annotations
import math, re
import numpy as np
import round13_anim as A
import round10_layers as L10
import round27_common as C

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!-- ROUND28 spine-motion -->"
CLIPS = ("full.idle", "full.walk", "full.run", "full.hop", "full.squat", "full.step", "full.cheer")


def drop_props(body, oid, props):
    def ko(m):
        if m.group(1) != oid:
            return m.group(0)
        inner = re.sub(r'<KeyedProperty property="(\w+)">.*?</KeyedProperty>',
                       lambda p: "" if p.group(1) in props else p.group(0), m.group(2), flags=re.S)
        return "" if "<KeyedProperty" not in inner else f'<KeyedObject objectId="{oid}">{inner}</KeyedObject>'
    return re.sub(r'\s*<KeyedObject objectId="(0:\d+)">(.*?)</KeyedObject>', ko, body, flags=re.S)


def main():
    s = SCENE.read_text(encoding="utf-8")
    if MARK in s:
        print("already applied"); return
    ids = A.ids_by_name(s); fk = C.FK(s)
    rest_up = {sd: C.angle(fk.world(f"full.arm-{sd}.upper")) for sd in "lr"}
    stats = {}
    for clip in CLIPS:
        dur, tr = fk.an[clip]
        loop = clip == "full.idle"
        g = lambda n, p, f, d=0.0: A.eval_track(tr[ids[n]][p], f) if p in tr.get(ids[n], {}) else d
        fr = lambda f: (f % dur) if loop else min(max(f, 0), dur)
        sp_b = tr.get(ids["full.pose"], {}).get("scaleY")
        bmin, bmax = (min(k[1] for k in sp_b), max(k[1] for k in sp_b)) if sp_b else (1, 1)
        frames = list(range(0, dur + 1, 2)) + ([dur] if dur % 2 else [])
        keyed_rig = ids["full.arm-l.rig"] in tr
        out = {}
        put = lambda n, p, f, v: out.setdefault((ids[n], p), []).append((f, v))
        mx = [0.0, 0.0]
        for f in frames:
            if clip in ("full.walk", "full.run"):
                sp = -1.35 * g("full.pelvis", "rotation", f)   # R36: lumbar = pelvis roll -> chest world = -0.35 x pelvis
                ss = 1.0 - (0.008 * max(0.0, g("full.pose", "y", f)) / 16.0 if clip == "full.run" else 0.0)
            elif clip in ("full.hop", "full.squat"):
                sp = 0.5 * g("full.torso", "rotation", fr(f - 4))
                ss = 1.0 - 0.03 * min(max(g("full.pose", "y", f) / 100.0, -0.4), 1.0)
            elif clip == "full.step":
                sp = 0.0015 * g("full.pose", "x", f); ss = 1.0
            elif clip == "full.cheer":
                rz = np.mean([abs(C.angle(fk.world(f"full.arm-{sd}.upper", clip, f)) - rest_up[sd]) for sd in "lr"])
                sp = 0.5 * g("full.torso", "rotation", fr(f - 4)); ss = 1.0 + 0.012 * min(rz / 0.4, 1.0)
            else:
                b = (g("full.pose", "scaleY", f, 1.0) - bmin) / ((bmax - bmin) or 1.0)
                sp = 0.35 * g("full.torso", "rotation", fr(f - 6)); ss = 1.0 + 0.0035 * b
            if not loop:
                fade = min(1.0, (dur - f) / 8.0)
                sp *= fade; ss = 1.0 + (ss - 1.0) * fade
            mx[0] = max(mx[0], abs(sp)); mx[1] = max(mx[1], abs(ss - 1))
            put("full.spine", "rotation", f, sp); put("full.spine", "scaleY", f, ss)
            put("full.head", "rotation", f, g("full.head", "rotation", f) - 0.7 * sp)
            R = fk.world("full.root", clip, f); Ri = np.linalg.inv(R)
            Cold = Ri @ fk.world("full.spine", clip, f)
            Cnew = Cold @ C.mat(0, 0, sp, 1.0, ss)
            Cb = Cold if keyed_rig else np.linalg.inv(fk.world("full.root")) @ fk.world("full.spine")
            D = Cnew @ np.linalg.inv(Cb)
            for sd in "lr":
                n = f"full.arm-{sd}.rig"
                L = D @ fk.local(n, clip if keyed_rig else None, f)
                put(n, "x", f, L[0, 2]); put(n, "y", f, L[1, 2]); put(n, "rotation", f, math.atan2(L[1, 0], L[0, 0]))
        m = re.search(rf'(<LinearAnimation name="{re.escape(clip)}"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
        body = m.group(2)
        body = drop_props(body, ids["full.head"], {"rotation"})
        body = drop_props(body, ids["full.spine"], {"rotation", "scaleY"})
        for sd in "lr":
            body = drop_props(body, ids[f"full.arm-{sd}.rig"], {"x", "y", "rotation"})
        add = "".join(f'\n            <KeyedObject objectId="{o}"><KeyedProperty property="{p}">' +
                      "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in kf) +
                      '</KeyedProperty></KeyedObject>' for (o, p), kf in out.items())
        s = s[:m.start(2)] + body + add + s[m.end(2):]
        stats[clip] = mx
        print(f"ROUND28 spine {clip}: |chest rot| <= {mx[0]:.4f} rad, |chest scaleY-1| <= {mx[1]:.4f}, rigs {'re-based' if keyed_rig else 'from rest'}")
    m = re.search(r'<!-- ROUND28 spine-skin -->', s)
    s = s[:m.end()] + "\n    " + MARK + s[m.end():]
    SCENE.write_text(s, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round28_spine_motion" not in bt:
        bt = bt.replace("python3 round28_spine_skin.py\n", "python3 round28_spine_skin.py\npython3 round28_spine_motion.py\n")
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


if __name__ == "__main__":
    main()
