#!/usr/bin/env python3
"""ROUND42c — layered head yaw for full.shake / full.look_lr / full.look_around.

Replaces the R41 feature-only parallax (r41yaw keys stripped in these clips) with per-layer depth
parallax on the R42 split head.  dx = PX * yaw * depth (local px, yaw in visual degrees):
  nose +0.85 | front bangs +0.55 | brows +0.60 | mouth +0.60 | eyes +0.30 (slide ~2.5 px in socket windows)
  skull silhouette rigid +0.18: face contour (scaleX compress), cap, baked strands, side locks (lagged)
  scalp backing +0.18 (rides skull, unscaled) | neck 0 | back hair -0.12 (lagged)
Silhouette ≈ depth 0 (contour stays on the skull), features carry the turn.
Far-side eye/brow scaleX foreshortening; iris leads (eyes 3 f ahead); hair groups lag 3 f.
Skinned chains move rigidly (group bone + chain root s1 shifted by the same dx → no stretch).
Idempotent (MARK)."""
from __future__ import annotations
import re
import round13_anim as A
import round10_layers as L10
import round41_head_yaw_motion as M41

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!--r42yaw-->"
YAW_MAX = 22.0
PX = 0.95
PITCH_PX = 0.55
FACE_S = 0.0        # face contour scaleX compress at |yaw|max
EYE_FAR, EYE_NEAR = 0.16, 0.04   # eye2.* (split eye parts) only
# R42c: full.eye.l/r draw eye-l/r.png which carry a large patch of baked cheek skin; any parallax or scaleX
# on them tore that skin off the face layer (cheek seam).  They ride the face rigidly (depth = face, no scale).
D = dict(nose=0.85, front=0.35, brow=0.45, mouth=0.60, eye=0.30, eyeskin=0.18, cap=0.18, face=0.18, side=0.18, scalp=0.18, back=-0.12)
CLIPS = ("full.shake", "full.look_lr", "full.look_around")
FRONT_CHAIN = ("full.bangs.a.s1", "full.bangs.b.s1", "full.bangs.c.s1")
SIDE_CHAIN = ("full.hair.lock.l.s1", "full.hair.lock.r.s1", "full.hair.back.l.s1", "full.hair.back.r.s1")
EYES = ("full.eye2.l", "full.eye2.r", "full.eye.l", "full.eye.r")
BROWS = ("full.brow.l", "full.brow.r")


def rest_xy(s, n):
    m = re.search(rf'<RootBone name="{re.escape(n)}"[^>]*>', s)
    t = m.group(0)
    return float(re.search(r'\bx="([-\d.]+)"', t).group(1)), float(re.search(r'\by="([-\d.]+)"', t).group(1))


def main():
    M41.YAW_MAX = YAW_MAX
    s = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(s)
    names = (["full.head.g." + g for g in ("front", "cap", "nose", "mouth", "face", "side", "scalp", "back")] + list(FRONT_CHAIN)
             + list(SIDE_CHAIN) + list(EYES) + list(BROWS) + ["full.mouth", "full.hair.clip",
             "full.eye2.l.ball", "full.eye2.r.ball", "full.head.yaw"])
    rest = {n: rest_xy(s, n) for n in names}
    cx = rest["full.head.g.face"][0]
    for clip in CLIPS:
        m = re.search(rf'(<LinearAnimation name="{re.escape(clip)}"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)',
                      s, re.S)
        dur = int(m.group(2)); body = m.group(3)
        for mk in (M41.MARK, MARK):
            body = re.sub(rf'\s*<KeyedObject objectId="0:\d+">{re.escape(mk)}.*?</KeyedObject>', "", body, flags=re.S)
        # hair.l / hair.r carry baked cheek-edge skin skinned to the lock chains: pre-R41 secondary lock
        # rotations slid that skin against the face (cheek seam).  In these clips hair lag is carried by the
        # lagged translation of g.side instead, so the lock-chain rotation tracks are dropped here.
        lock_ids = {ids[f"full.hair.lock.{sd}.s{k}"] for sd in "lr" for k in (1, 2, 3)}
        body = re.sub(r'\s*<KeyedObject objectId="(0:\d+)">\s*<KeyedProperty property="rotation">.*?</KeyedProperty>\s*</KeyedObject>',
                      lambda k: "" if k.group(1) in lock_ids else k.group(0), body, flags=re.S)
        tr = {}
        def put(n, p, f, v):
            tr.setdefault((ids[n], p), []).append((f, float(v)))
        for f in sorted(set(range(0, dur + 1, 2)) | {dur}):
            yaw, pitch, hair, eye = M41.yaw_of(clip, f, dur)
            u = abs(yaw) / YAW_MAX
            def dx(dep, y=yaw): return PX * y * dep
            def dy(dep): return PITCH_PX * pitch * dep
            put("full.head.yaw", "x", f, yaw)
            sface = 1.0 - FACE_S * u
            put("full.head.g.face", "x", f, cx + dx(D["face"])); put("full.head.g.face", "scaleX", f, sface)
            put("full.head.g.face", "y", f, dy(D["face"]))
            for g, yy in (("front", yaw), ("cap", yaw), ("nose", yaw), ("mouth", yaw), ("side", yaw), ("scalp", yaw), ("back", hair)):
                dep = D[g]
                put(f"full.head.g.{g}", "x", f, dx(dep, yy))
                if dep > 0:
                    put(f"full.head.g.{g}", "y", f, dy(dep))
            for n in FRONT_CHAIN:
                put(n, "x", f, rest[n][0] + dx(D["front"])); put(n, "y", f, rest[n][1] + dy(D["front"]))
            for n in SIDE_CHAIN:
                put(n, "x", f, rest[n][0] + (dx(D["side"], yaw) if "lock" in n else dx(D["back"], hair)))
            put("full.hair.clip", "x", f, rest["full.hair.clip"][0] + dx(D["cap"]))
            put("full.hair.clip", "y", f, rest["full.hair.clip"][1] + dy(D["cap"]))
            for n, dep in [(e, D["eye"] if "eye2" in e else D["eyeskin"]) for e in EYES] + [(b, D["brow"]) for b in BROWS] + [("full.mouth", D["mouth"])]:
                rx, ry = rest[n]
                put(n, "x", f, cx + (rx - cx) * sface + dx(dep)); put(n, "y", f, ry + dy(dep))
                if (n in EYES and "eye2" in n) or n in BROWS:
                    left = n.endswith(".l")
                    far = (yaw > 0) == left
                    put(n, "scaleX", f, (1 - EYE_FAR * u) if far else (1 + EYE_NEAR * u))
            for sd in ("l", "r"):
                n = f"full.eye2.{sd}.ball"
                put(n, "x", f, rest[n][0] + PX * (eye - yaw) * 0.25)
        add = "".join(
            f'\n            <KeyedObject objectId="{oid}">{MARK}<KeyedProperty property="{p}">'
            + "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in kf)
            + "</KeyedProperty></KeyedObject>" for (oid, p), kf in tr.items())
        s = s[:m.start(3)] + body + add + s[m.end(3):]
        print(f"ROUND42c yaw {clip}: {dur}f {len(tr)} tracks")
    SCENE.write_text(s, encoding="utf-8")


if __name__ == "__main__":
    main()
