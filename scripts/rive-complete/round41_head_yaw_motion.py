#!/usr/bin/env python3
"""ROUND41b — bake pseudo-3D yaw parallax into full.shake / look_lr / look_around / nod.

Yaw is a front-view stand-in for head turn (~±22° visual): depth-ranked local x shifts under
full.head, far-side eye/brow/cheek scaleX compress, near-side slight widen, back hair shifts
opposite.  Neck gets a small x (head rides it); shoulders untouched.

Clips (duration 72 @ 60 fps):
  shake        yaw = A*sin(2π f/P) * ease envelope; hair lags 3 f
  look_lr      hold L → center → hold R → center
  look_around  yaw figure-8-ish + small pitch; eyes lead head by 3 f
  nod          keep secondary keys; add slight pitch parallax (feature y) — cheap

Cheek pieces opacity 1 / head.image 0 while |yaw|+|pitch| > ε, restored on f0 and last frame.
Idempotent: strips its own KeyedObjects (MARKER) then rebuilds.  Requires round41_head_yaw_rig."""
from __future__ import annotations
import math, re
import round13_anim as A
import round10_layers as L10

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!--r41yaw-->"
YAW_MAX = 28.0          # degrees visual
PX = 0.90               # px per degree at depth 1.0  (~25 px at mouth)
FS = 0.04               # mild far-side scaleX (strong shrink opens head eye-cutout voids)
NS = 0.03
NECK_X = 0.0  # unused — neck must not translate/rotate in these clips
PITCH_PX = 0.55         # feature y per pitch-degree

# depth: + = in front of head pivot (shift WITH yaw), - = behind (opposite)
DEPTH = {
    "full.mouth": 1.00,
    "full.brow.l": 0.90, "full.brow.r": 0.90,
    "full.hair.clip": 0.35,
    # cheeks: same depth (no relative slide → no seam gap); scaleX foreshortens far/near
    # eyes depth 0 — head.png has eye cutouts; any slide opens black voids
    "full.eye2.l": 0.0, "full.eye2.r": 0.0,
    "full.eye.l": 0.0, "full.eye.r": 0.0,
}

# which side is "left" on screen for foreshortening
LEFT = {"full.eye2.l", "full.eye.l", "full.brow.l"}
RIGHT = {"full.eye2.r", "full.eye.r", "full.brow.r"}

CLIPS = ("full.shake", "full.look_lr", "full.look_around", "full.nod")


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def ss(t):
    return ease(t)


def yaw_of(clip, f, dur):
    """returns (yaw_deg, pitch_deg, hair_yaw_deg, eye_yaw_deg)."""
    env = ss(f / 8.0) * (1 - ss((f - (dur - 10)) / 10.0)) if 0 < f < dur else 0.0
    if clip == "full.shake":
        # ~2.5 cycles
        yaw = YAW_MAX * 0.95 * math.sin(2 * math.pi * f / 28.0) * env
        pitch = 0.0
        hair = YAW_MAX * 0.95 * math.sin(2 * math.pi * max(0, f - 3) / 28.0) * (
            ss(max(0, f - 3) / 8.0) * (1 - ss((max(0, f - 3) - (dur - 10)) / 10.0)) if 0 < f < dur else 0.0)
        eye = yaw  # with head for shake
    elif clip == "full.look_lr":
        # 0-8 ramp L, 8-20 hold L, 20-28 to 0, 28-36 to R, 36-48 hold R, 48-58 to 0, settle
        def yaw_at(ff):
            ff = min(max(int(ff), 0), dur)
            if ff in (0, dur):
                return 0.0
            def seg(fa, fb, ya, yb):
                if ff <= fa: return ya
                if ff >= fb: return yb
                return ya + (yb - ya) * ease((ff - fa) / (fb - fa))
            y = seg(0, 8, 0, -YAW_MAX)
            y = seg(8, 20, -YAW_MAX, -YAW_MAX) if ff >= 8 else y
            y = seg(20, 28, -YAW_MAX, 0) if ff >= 20 else y
            y = seg(28, 36, 0, YAW_MAX) if ff >= 28 else y
            y = seg(36, 48, YAW_MAX, YAW_MAX) if ff >= 36 else y
            y = seg(48, 58, YAW_MAX, 0) if ff >= 48 else y
            return y if ff < 58 else seg(58, dur, 0, 0)
        yaw = yaw_at(f)
        pitch = 0.0
        hair = yaw_at(max(0, f - 3))
        eye = yaw_at(min(dur, f + 3))
    elif clip == "full.look_around":
        # yaw + pitch: look up-left, up-right, down-right, down-left, center
        # parametric
        t = f / max(dur, 1)
        yaw = YAW_MAX * 0.85 * math.sin(2 * math.pi * t * 1.0) * env
        pitch = 8.0 * math.sin(2 * math.pi * t * 1.0 + math.pi / 2) * env
        hair = YAW_MAX * 0.85 * math.sin(2 * math.pi * max(0, f - 3) / dur) * (
            ss(max(0, f - 3) / 8.0) * (1 - ss((max(0, f - 3) - (dur - 10)) / 10.0)) if 0 < f < dur else 0.0)
        eye_f = min(dur, f + 3)
        eye_env = ss(eye_f / 8.0) * (1 - ss((eye_f - (dur - 10)) / 10.0)) if 0 < eye_f < dur else 0.0
        eye = YAW_MAX * 0.85 * math.sin(2 * math.pi * eye_f / dur) * eye_env
    else:  # nod — pitch only, tiny yaw 0
        # nod already has secondary; we add pitch parallax
        # approximate nod pitch from a sin bump
        pitch = 10.0 * math.sin(math.pi * f / max(dur * 0.55, 1)) * env if f < dur * 0.7 else 0.0
        if f >= dur * 0.55:
            pitch = 10.0 * math.sin(math.pi * (dur - f) / max(dur * 0.45, 1)) * env * 0.3
        yaw = 0.0
        hair = 0.0
        eye = 0.0
        # cleaner nod pitch: down then up
        pitch = -12.0 * math.sin(math.pi * min(f, dur) / dur) * env
    return yaw, pitch, hair, eye


def foreshorten(name, yaw):
    """scaleX multiplier for far/near side."""
    u = abs(yaw) / YAW_MAX
    if name in LEFT:
        # yaw>0 (look +x): left is far
        return (1.0 - FS * u) if yaw > 0 else (1.0 + NS * u)
    if name in RIGHT:
        return (1.0 - FS * u) if yaw < 0 else (1.0 + NS * u)
    if name == "full.head.cheek.c":
        return 1.0 - 0.06 * u
    return 1.0


def main():
    s = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(s)
    # rest local x/y for bones we shift
    rest = {}
    for n in list(DEPTH) + ["full.neck", "full.head", "full.head.yaw",
                            "full.eye2.l.ball", "full.eye2.r.ball"]:
        if n not in ids:
            continue
        m = re.search(rf'<RootBone name="{re.escape(n)}"[^>]*\bx="([-\d.]+)"[^>]*\by="([-\d.]+)"', s)
        if not m:
            m = re.search(rf'<RootBone name="{re.escape(n)}"[^>]*\by="([-\d.]+)"[^>]*\bx="([-\d.]+)"', s)
            if m:
                rest[n] = (float(m.group(2)), float(m.group(1))); continue
        rest[n] = (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)

    own_bones = set()
    for n in list(DEPTH) + [
        "full.neck", "full.head", "full.head.yaw",
        "full.eye2.l.ball", "full.eye2.r.ball",
        "full.head.cheek.l", "full.head.cheek.c", "full.head.cheek.r",
        "full.bangs.a.s1", "full.bangs.b.s1", "full.bangs.c.s1",
        "full.hair.lock.l.s1", "full.hair.lock.r.s1",
        "full.hair.back.l.s1", "full.hair.back.r.s1", "full.hair.bow",
    ]:
        if n in ids:
            own_bones.add(ids[n])
    img_ids = set()
    for n in ("full.head.image", "full.head.cheek.l.image", "full.head.cheek.c.image",
              "full.head.cheek.r.image", "full.head.face.backfill.image"):
        if n in ids: img_ids.add(ids[n])

    for clip in CLIPS:
        m = re.search(
            rf'(<LinearAnimation name="{re.escape(clip)}"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)',
            s, re.S)
        if not m:
            print("MISSING", clip); continue
        dur = int(m.group(2)); body = m.group(3)
        # strip previous R41 keys
        body = re.sub(
            rf'\s*<KeyedObject objectId="(0:\d+)">{MARK}<KeyedProperty property="(?:x|y|scaleX|opacity|rotation)">.*?</KeyedProperty></KeyedObject>',
            "", body, flags=re.S)
        # also strip un-marked keys we own on these clips (first run / repair)
        def drop(k):
            oid = k.group(1)
            if oid in own_bones or oid in img_ids:
                prop = k.group(2)
                # never strip hair/bangs rotation here — those are pre-R41 secondary tracks
                hairish = oid in {ids.get(n) for n in (
                    "full.bangs.a.s1","full.bangs.a.s2","full.bangs.b.s1","full.bangs.b.s2",
                    "full.bangs.c.s1","full.bangs.c.s2",
                    "full.hair.lock.l.s1","full.hair.lock.l.s2","full.hair.lock.l.s3",
                    "full.hair.lock.r.s1","full.hair.lock.r.s2","full.hair.lock.r.s3",
                    "full.hair.back.l.s1","full.hair.back.l.s2",
                    "full.hair.back.r.s1","full.hair.back.r.s2")}
                if prop == "rotation" and hairish:
                    return k.group(0)
                if prop in ("x", "y", "scaleX", "opacity"):
                    return ""
                if prop == "rotation" and oid in {ids.get("full.neck"), ids.get("full.head")}:
                    return ""
                if oid in img_ids and prop == "opacity":
                    return ""
                if oid == ids.get("full.neck") and prop in ("x", "rotation"):
                    return ""
                if oid == ids.get("full.head") and prop in ("x", "scaleX", "rotation"):
                    return ""
            return k.group(0)
        # Match both self-closing KeyFrameDouble and nested cubic (CubicEaseInterpolator children)
        body = re.sub(
            r'\s*<KeyedObject objectId="(0:\d+)">\s*<KeyedProperty property="(x|y|scaleX|opacity|rotation)">.*?</KeyedProperty>\s*</KeyedObject>',
            drop, body, flags=re.S)

        frames = sorted(set(range(0, dur + 1, 2)) | {dur})
        tr = {}  # (oid, prop) -> [(f,v)]

        def put(name, prop, f, v):
            if name not in ids:
                return
            tr.setdefault((ids[name], prop), []).append((f, float(v)))

        for f in frames:
            yaw, pitch, hair_yaw, eye_yaw = yaw_of(clip, f, dur)
            put("full.head.yaw", "x", f, yaw)          # control readout (degrees)
            # head foreshorten slightly
            # leave head unkeyed (rest)

            for name, dep in DEPTH.items():
                if name not in rest:
                    continue
                rx, ry = rest[name]
                yuse = hair_yaw if dep < 0 else yaw
                dx = PX * yuse * dep
                dy = PITCH_PX * pitch * max(dep, 0.25)
                put(name, "x", f, rx + dx)
                if abs(pitch) > 1e-3 and dep > 0:
                    put(name, "y", f, ry + dy)
                # no scaleX on eyes/brows — foreshorten via x-parallax only (scale opens cutouts / fake seams)
                _ = foreshorten(name, yaw)  # kept for possible future cheek use
                # cheeks: no scaleX — different pivots would reopen feathered seams

            # eyes lead: extra x on eye balls
            for side in ("l", "r"):
                bn = f"full.eye2.{side}.ball"
                if bn in rest:
                    lead = PX * (eye_yaw - yaw) * 0.20
                    put(bn, "x", f, rest[bn][0] + lead)
            # hair: keep pre-R41 secondary rotation tracks (do not re-key) — tips stay skinned to locks.

            # head.image stays visible as the hole-proof base; cheek strips + face-backfill overlay while yawing
            active = (abs(yaw) + abs(pitch)) > 0.4 and 0 < f < dur
            # SAFE: keep original head.image; cheek strips stay off (seam risk). Contour = feature parallax only.
            put("full.head.image", "opacity", f, 1.0)
            put("full.head.face.backfill.image", "opacity", f, 0.0)  # off: showed through head side-cutouts as fake cheek seams
            for tag in "lcr":
                put(f"full.head.cheek.{tag}.image", "opacity", f, 0.0)

        add = []
        for (oid, prop), kf in tr.items():
            # hold for opacity, linear else
            itp = "hold" if prop == "opacity" else "linear"
            ks = "".join(
                f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="{itp}"/>' for f, v in kf)
            add.append(
                f'\n            <KeyedObject objectId="{oid}">{MARK}<KeyedProperty property="{prop}">{ks}'
                f'</KeyedProperty></KeyedObject>')
        s = s[: m.start(3)] + body + "".join(add) + s[m.end(3):]
        print(f"ROUND41 yaw motion {clip}: {dur}f, {len(tr)} tracks")

    SCENE.write_text(s, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round41_head_yaw_motion" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(
            bt.rstrip("\n") + "\npython3 round41_head_yaw_motion.py\n")


if __name__ == "__main__":
    main()
