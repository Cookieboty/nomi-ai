#!/usr/bin/env python3
"""ROUND32a: restore static finger rest + loop-safe finger tracks.

Findings (v32 audit):
- Idle has no finger rotation tracks; bone defaults are 0 — texture-space parts already
  match master crops (MAE≈3.7–7.5). Rendered idle vs master sil_xor≈15% is mostly
  ownership-skirt / MSAA / cuff overlap, not a large pose error.
- R26 wave/cheer/clap finger tracks end NON-ZERO (wave ≈−0.14 rad) because follow-through
  lag does not decay to 0 at clip end → loop pop and possible SM hold of curled rest.
- Fix: rebuild wave/cheer/clap finger rotation tracks with the same R26 model but force
  value=0 at frame 0 and frame=duration (ease lag out in the last 8f). Keep mid-clip
  follow-through so wave/cheer/clap still look alive.

Idempotent via MARK rewrite.
"""
from __future__ import annotations
import math, re
import round13_anim as A
import round21_arm_fk as FK
import round10_layers as L10

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!-- ROUND32 finger-rest -->"
MARK26 = "<!-- ROUND26 fingers -->"
FING = ("thumb", "index", "middle", "ring", "little")
SEG = ("", ".1", ".2")
SEG_K = {"": 1.0, ".1": 0.6, ".2": 0.35}
CLIPS = {
    "full.wave": ("r", 0.0, 5, 0.55, ()),
    "full.cheer": ("lr", 0.10, 5, 0.45, ()),
    "full.clap": ("lr", 0.0, 4, 0.35, (28, 52)),
}
LAG_MAX = 0.16
TAIL = 8  # frames to ease lag→0 at end


def curl_dir(tr, ids):
    out = {}
    for s in "lr":
        for fg in FING:
            for sg in SEG:
                k = tr.get(ids[f"full.arm-{s}.{fg}{sg}"], {}).get("rotation", [])
                v = max((x[1] for x in k), key=abs, default=0.0)
                out[(s, fg, sg)] = v
    return out


def end_ease(f, dur):
    if dur <= 0:
        return 0.0
    if f <= 0:
        return 0.0
    if f >= dur:
        return 0.0
    # full strength until last TAIL frames, then linear to 0
    if f <= dur - TAIL:
        return 1.0
    return max(0.0, (dur - f) / TAIL)


def main():
    scene = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(scene)
    an = A.animations(scene)
    # Always rebuild (strip prior R26/R32 finger tracks on these clips)
    if "full.fist" not in an:
        raise SystemExit("full.fist missing")
    fist = curl_dir(an["full.fist"][1], ids)
    rep = {}
    for clip, (sides, relax, D, gain, impacts) in CLIPS.items():
        dur, tr = an[clip]
        frames = list(range(0, dur + 1, 2))
        if frames[-1] != dur:
            frames.append(dur)
        worst = 0.0
        for s in sides:
            def hw(f, _tr=tr, _s=s):
                return sum(
                    A.eval_track(_tr.get(ids[f"full.arm-{_s}.{b}"], {}).get("rotation", []), max(0, f)) or 0.0
                    for b in ("upper", "fore", "hand")
                )

            env = lambda f, _d=dur: min(1.0, f / 10.0, max(0.0, (_d - f) / 10.0))
            for fg in FING:
                for sg in SEG:
                    oid = ids[f"full.arm-{s}.{fg}{sg}"]
                    old = tr.get(oid, {}).get("rotation", [])
                    # Prefer pre-R26 base: if old track looks like R26 (many keys), use 0 base
                    base_track = old if old and len(old) < 20 else []
                    cd = fist[(s, fg, sg)]
                    vals = []
                    for f in frames:
                        if f == 0 or f == dur:
                            vals.append((f, 0.0))
                            continue
                        base = (A.eval_track(base_track, f) or 0.0) + relax * cd * env(f)
                        lag = max(-LAG_MAX, min(LAG_MAX, gain * (hw(f - D) - hw(f)))) * SEG_K[sg]
                        pulse = 0.0
                        for fi in impacts:
                            u = f - fi
                            if 0 <= u < 4:
                                pulse = -0.10 * math.sin(math.pi * u / 4) * math.copysign(1, cd or 1) * SEG_K[sg]
                            elif 4 <= u < 14:
                                pulse = 0.04 * math.sin(math.pi * (u - 4) / 10) * math.copysign(1, cd or 1) * SEG_K[sg]
                        ee = end_ease(f, dur)
                        v = (base + lag + pulse) * ee
                        worst = max(worst, abs(lag * ee))
                        vals.append((f, v))
                    scene = FK.strip(scene, clip, oid, "rotation")
                    kf = "".join(
                        f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>'
                        for f, v in vals
                    )
                    scene = A.add_to_anim(
                        scene,
                        clip,
                        f'<KeyedObject objectId="{oid}"><KeyedProperty property="rotation">{kf}</KeyedProperty></KeyedObject>',
                    )
        rep[clip] = worst
    if MARK not in scene:
        if MARK26 in scene:
            scene = scene.replace(MARK26, MARK26 + "\n    " + MARK, 1)
        else:
            scene = re.sub(r"(<Artboard\b[^>]*>)", r"\1\n    " + MARK, scene, count=1)
    SCENE.write_text(scene, encoding="utf-8")
    for k, w in rep.items():
        print(f"ROUND32 finger-rest {k}: max lagged mid {w:.3f} rad (ends forced 0)")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round32_finger_rest" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(
            bt.rstrip() + "\npython3 round32_finger_rest.py\n"
        )


if __name__ == "__main__":
    main()
