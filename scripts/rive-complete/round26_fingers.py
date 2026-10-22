#!/usr/bin/env python3
"""ROUND26 item 2 - natural finger motion in wave / cheer / clap.

The hands were already split in R10-R14 into palm + web + thumb + index + middle + ring + little images, each skinned
on 3-segment finger chains (arm-X.<finger>, .1, .2) under arm-X.hand (see R23 inventory).  What was missing is finger
*motion*: wave had a static 5-key curl, cheer had none, clap a static mild curl.

Per clip (keys every 2 f, linear, so they ride on the existing hand keys):
  base(f)   = the clip's existing finger curl (0 if none) + RELAX * fist-curl direction
  lag(f)    = clamp(hw(f - D) - hw(f), +-LAG_MAX)   hw = hand world angle (upper + fore + hand)
              -> fingers trail the hand when it flaps (follow-through); proximal gets 1x, .1 0.6x, .2 0.35x.
              Rotation lag is sign-independent of curl direction, so it bends in the hand's travel plane only.
  clap only: impact pulse at the two hand contacts (f28, f52): fingers flick open (-0.10 * curl dir) for 4 f
              then settle back with a 0.04 over-curl over 10 f.
Curl direction per bone = sign of that bone in full.fist (the verified fist), so "curl" always goes toward the palm.
Idempotent via MARK (re-run strips and rebuilds only the finger tracks of these clips)."""
from __future__ import annotations
import math, re
import round13_anim as A
import round21_arm_fk as FK
import round10_layers as L10

SCENE = L10.PROJECT / "scene.rml"
MARK = "<!-- ROUND26 fingers -->"
FING = ("thumb", "index", "middle", "ring", "little")
SEG = ("", ".1", ".2")
SEG_K = {"": 1.0, ".1": 0.6, ".2": 0.35}
CLIPS = {  # clip: (sides, RELAX curl fraction of fist, lag delay f, lag gain, impacts)
    "full.wave": ("r", 0.0, 5, 0.55, ()),
    "full.cheer": ("lr", 0.10, 5, 0.45, ()),
    "full.clap": ("lr", 0.0, 4, 0.35, (28, 52)),
}
LAG_MAX = 0.16


def curl_dir(tr, ids):
    out = {}
    for s in "lr":
        for fg in FING:
            for sg in SEG:
                k = tr.get(ids[f"full.arm-{s}.{fg}{sg}"], {}).get("rotation", [])
                v = max((x[1] for x in k), key=abs, default=0.0)
                out[(s, fg, sg)] = v  # signed full-fist value
    return out


def main():
    scene = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(scene)
    an = A.animations(scene)
    if MARK in scene:  # rebuild from the pre-R26 values stored in the mark-free git copy is not needed: we only
        print("already applied"); return
    fist = curl_dir(an["full.fist"][1], ids)
    rep = {}
    for clip, (sides, relax, D, gain, impacts) in CLIPS.items():
        dur, tr = an[clip]
        frames = list(range(0, dur + 1, 2))
        if frames[-1] != dur:
            frames.append(dur)
        worst = 0.0
        for s in sides:
            def hw(f):
                return sum(A.eval_track(tr.get(ids[f"full.arm-{s}.{b}"], {}).get("rotation", []), max(0, f)) or 0.0
                           for b in ("upper", "fore", "hand"))
            env = lambda f: min(1.0, f / 10.0, max(0.0, (dur - f) / 10.0))
            for fg in FING:
                for sg in SEG:
                    oid = ids[f"full.arm-{s}.{fg}{sg}"]
                    old = tr.get(oid, {}).get("rotation", [])
                    cd = fist[(s, fg, sg)]
                    vals = []
                    for f in frames:
                        base = (A.eval_track(old, f) or 0.0) + relax * cd * env(f)
                        lag = max(-LAG_MAX, min(LAG_MAX, gain * (hw(f - D) - hw(f)))) * SEG_K[sg]
                        pulse = 0.0
                        for fi in impacts:
                            u = f - fi
                            if 0 <= u < 4:
                                pulse = -0.10 * math.sin(math.pi * u / 4) * math.copysign(1, cd) * SEG_K[sg]
                            elif 4 <= u < 14:
                                pulse = 0.04 * math.sin(math.pi * (u - 4) / 10) * math.copysign(1, cd) * SEG_K[sg]
                        v = base + lag + pulse
                        worst = max(worst, abs(lag))
                        vals.append((f, v))
                    scene = FK.strip(scene, clip, oid, "rotation")
                    kf = "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in vals)
                    scene = A.add_to_anim(scene, clip, f'<KeyedObject objectId="{oid}"><KeyedProperty property="rotation">{kf}</KeyedProperty></KeyedObject>')
        rep[clip] = worst
    m = re.search(r'<!-- ROUND25[^>]*-->', scene)
    scene = scene[:m.end()] + "\n    " + MARK + scene[m.end():]
    SCENE.write_text(scene, encoding="utf-8")
    for k, w in rep.items():
        print(f"ROUND26 fingers {k}: max follow-through lag {w:.3f} rad")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round26_fingers" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round26_fingers.py\n")


if __name__ == "__main__":
    main()
