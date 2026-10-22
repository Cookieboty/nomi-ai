#!/usr/bin/env python3
"""ROUND43 — conservative head turn for full.shake / full.look_lr / full.look_around.

R42b's per-layer parallax tore the face apart (eyes spread, nose/mouth slid off).  R43 keeps the
whole face (skin, features, bangs) as ONE rigid unit carried by full.head (small translate + roll;
the neck mesh is skinned head/torso/spine so it bends with it).  On top, features get only tiny
extra offsets: nose <=3 px, mouth <=2 px, eyes/brows/bangs <=1 px (both eyes identical, no scaleX).
Back hair lags slightly opposite.  Strips the R41 yaw keys (r41yaw) of these clips and rebuilds.
Idempotent (MARK)."""
from __future__ import annotations
import re
import round13_anim as A
import round10_layers as L10
import round41_head_yaw_motion as M41

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!--r43yaw-->"
CLIPS = ("full.shake", "full.look_lr", "full.look_around")
YMAX = M41.YAW_MAX           # yaw_of() peaks at ±YMAX; s = yaw/YMAX in [-1, 1]
HEAD_X, HEAD_ROLL = 4.0, 0.030   # px, rad (~1.7°)
PITCH_Y = 0.25               # px per pitch-degree (look_around only, ±2 px)
EXTRA = {"full.head.g.nose": 3.0, "full.head.g.mouth": 2.0,
         "full.eye2.l": 1.0, "full.eye2.r": 1.0, "full.brow.l": 1.0, "full.brow.r": 1.0,
         "full.head.g.front": 1.0, "full.bangs.a.s1": 1.0, "full.bangs.b.s1": 1.0, "full.bangs.c.s1": 1.0,
         "full.hair.clip": 1.0}
BACK = {"full.head.g.back": -2.0, "full.hair.back.l.s1": -2.0, "full.hair.back.r.s1": -2.0}
IRIS = 1.0                   # iris lead px (identical both eyes)


def rest_xy(s, n):
    t = re.search(rf'<RootBone name="{re.escape(n)}"[^>]*>', s).group(0)
    return float(re.search(r'\bx="([-\d.]+)"', t).group(1)), float(re.search(r'\by="([-\d.]+)"', t).group(1))


def main():
    s = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(s)
    names = list(EXTRA) + list(BACK) + ["full.head", "full.eye2.l.ball", "full.eye2.r.ball"]
    rest = {n: rest_xy(s, n) for n in names}
    for clip in CLIPS:
        m = re.search(rf'(<LinearAnimation name="{re.escape(clip)}"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)',
                      s, re.S)
        dur = int(m.group(2)); body = m.group(3)
        for mk in (M41.MARK, MARK):
            body = re.sub(rf'\s*<KeyedObject objectId="0:\d+">\s*{re.escape(mk)}.*?</KeyedObject>', "", body, flags=re.S)
        assert M41.MARK not in body, clip
        tr = {}
        def put(n, p, f, v):
            tr.setdefault((ids[n], p), []).append((f, float(v)))
        for f in range(dur + 1):
            yaw, pitch, hair, eye = M41.yaw_of(clip, f, dur)
            sy, sh, se = yaw / YMAX, hair / YMAX, eye / YMAX
            hx, hy = rest["full.head"]
            put("full.head", "x", f, hx + HEAD_X * sy)
            put("full.head", "y", f, hy - PITCH_Y * pitch)
            put("full.head", "rotation", f, -HEAD_ROLL * sy)
            for n, a in EXTRA.items():
                put(n, "x", f, rest[n][0] + a * sy)
            for n, a in BACK.items():
                put(n, "x", f, rest[n][0] + a * sh)
            for n in ("full.eye2.l.ball", "full.eye2.r.ball"):
                put(n, "x", f, rest[n][0] + IRIS * (se - sy))
        add = "".join(
            f'\n            <KeyedObject objectId="{oid}">{MARK}<KeyedProperty property="{p}">'
            + "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in kf)
            + "</KeyedProperty></KeyedObject>" for (oid, p), kf in tr.items())
        s = s[:m.start(3)] + body + add + s[m.end(3):]
        print(f"ROUND43 yaw {clip}: {dur}f {len(tr)} tracks")
    SCENE.write_text(s, encoding="utf-8")


if __name__ == "__main__":
    main()
