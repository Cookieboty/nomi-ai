#!/usr/bin/env python3
"""ROUND10 — minimal ``fist`` clip to validate extreme finger curl on the skinned hands.

Adds to scene.rml (idempotent: replaces an earlier ROUND10 fist block):
  * ViewModelPropertyTrigger ``fist`` (0:291) + Default-instance trigger
  * LinearAnimation ``full.fist`` (0:331, 72f @60): both hands, 5 fingers x 3 joints curl to a closed fist, a squeeze
    overshoot (115 %), hold, release.  Only finger bones are keyed (arms stay at the idle pose).
  * AnimationState (0:431) + transition from the ``rest`` state of the Actions layer.

ROUND11: the thumb joints use per-joint progress curves (THUMB_G), see below.

run: python3 round10_fist.py [--scale 1.0]   (scale multiplies every curl angle; for stress tests)
"""
from __future__ import annotations

import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCENE = ROOT / "rive" / "nomi-complete" / "scene.rml"

TRIG_ID, ANIM_ID, STATE_ID = "0:291", "0:331", "0:431"
# bone ids (round9_scene.HANDS)
BONES = {
    "l": {"root": {"thumb": "0:9243", "index": "0:9244", "middle": "0:9245", "ring": "0:9246", "little": "0:9247"},
          "p1": {"thumb": "0:9290", "index": "0:9292", "middle": "0:9294", "ring": "0:9296", "little": "0:9298"},
          "p2": {"thumb": "0:9291", "index": "0:9293", "middle": "0:9295", "ring": "0:9297", "little": "0:9299"}},
    "r": {"root": {"thumb": "0:9248", "index": "0:9249", "middle": "0:9250", "ring": "0:9251", "little": "0:9252"},
          "p1": {"thumb": "0:9300", "index": "0:9302", "middle": "0:9304", "ring": "0:9306", "little": "0:9308"},
          "p2": {"thumb": "0:9301", "index": "0:9303", "middle": "0:9305", "ring": "0:9307", "little": "0:9309"}},
}
# curl in degrees (MCP, PIP, DIP), positive = clockwise on screen, left hand; the right hand is mirrored (x -1).
# Chosen with fistsim_*.py: tips stay inside the rest hull of the hand (see REPORT-ROUND10.md)
CURL = {
    "thumb": (-27.0, -76.0, -40.0),
    "index": (40.0, 63.0, 46.0),
    "middle": (-100.0, -45.0, -55.0),
    "ring": (-100.0, -45.0, -55.0),
    "little": (-100.0, -45.0, -55.0),
}
# (frame, factor) — 1.0 = closed fist, 1.15 = squeeze overshoot
TIMELINE = [(0, 0.0), (16, 1.0), (28, 1.15), (44, 1.0), (58, 1.0), (72, 0.0)]
EASE = '<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>'


# ---- ROUND11: thumb joints no longer share one progress curve -------------------------------------------------------------
# With the same factor on root/p1/p2 (R10) the thumb passes through poses at 30-80 % where the root has already swung
# -27 deg while p1/p2 are still straight: the thumb tip sweeps SIDEWAYS out of the palm width (peak around f66 on the way back, f8-f16
# on the way in; fistsim.py: up to 53 px of thumb outside the palm band on the left hand).  A real thumb folds the distal joints first
# and the root last, so the tip travels inward along the palm.  Per-joint progress g_j(f) of the master factor f in [0, 1] (smoothstep,
# found with a 3-parameter search: scratch/rive-bone-rig/v11/tools/search*.py; 1.0 -> 1.0, so the closed fist is unchanged):
#   root : starts at 40 % of the master progress     p1 : done at 60 %     p2 : done at 30 %
# For the squeeze overshoot (f > 1) every joint just follows f.  The thumb tracks are sampled every 2 frames (linear keys)
# because the per-joint remap of the eased master curve can no longer be written with one cubic ease per segment.
THUMB_G = {"root": (0.4, 1.0), "p1": (0.0, 0.6), "p2": (0.0, 0.3)}   # (delay, finish) -> smoothstep((f - delay) / (finish - delay if delay else finish))


def _smooth(x: float) -> float:
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def thumb_g(joint: str, f: float) -> float:
    if f > 1.0:
        return f                       # squeeze overshoot: all joints follow the master factor
    delay, finish = THUMB_G[joint]
    return _smooth((f - delay) / (finish - delay))


def master(frame: int) -> float:
    """master factor f(t) of TIMELINE with the cubic ease (0.42, 0, 0.58, 1) on every segment (what Rive plays for the other fingers)"""
    for (t0, f0), (t1, f1) in zip(TIMELINE, TIMELINE[1:]):
        if t0 <= frame <= t1:
            x = (frame - t0) / (t1 - t0)
            lo, hi = 0.0, 1.0                           # solve bezier x(u) = x, then y(u)
            for _ in range(60):
                u = (lo + hi) / 2
                bx = 3 * (1 - u) ** 2 * u * 0.42 + 3 * (1 - u) * u * u * 0.58 + u ** 3
                lo, hi = (u, hi) if bx < x else (lo, u)
            u = (lo + hi) / 2
            by = 3 * (1 - u) * u * u * 1.0 + u ** 3
            return f0 + (f1 - f0) * by
    return 0.0


def thumb_track(bone: str, joint: str, deg: float, scale: float) -> str:
    keys = "".join(
        f'<KeyFrameDouble value="{math.radians(deg) * thumb_g(joint, master(fr)) * scale:.6f}" frame="{fr}" interpolationType="linear"/>'
        for fr in range(0, TIMELINE[-1][0] + 1, 2))
    return f'<KeyedObject objectId="{bone}"><KeyedProperty property="rotation">{keys}</KeyedProperty></KeyedObject>\n'


def track(bone: str, deg: float, scale: float) -> str:
    keys = "".join(
        f'<KeyFrameDouble value="{math.radians(deg) * f * scale:.6f}" frame="{fr}" interpolationType="cubic">{EASE}</KeyFrameDouble>'
        for fr, f in TIMELINE)
    return f'<KeyedObject objectId="{bone}"><KeyedProperty property="rotation">{keys}</KeyedProperty></KeyedObject>\n'


def animation(scale: float) -> str:
    out = [f'        <LinearAnimation name="full.fist" loopValue="oneShot" duration="72" fps="60" id="{ANIM_ID}">\n']
    for side, sgn in (("l", 1.0), ("r", -1.0)):
        b = BONES[side]
        for finger, (a0, a1, a2) in CURL.items():
            if finger == "thumb":
                out += [thumb_track(b["root"][finger], "root", sgn * a0, scale), thumb_track(b["p1"][finger], "p1", sgn * a1, scale),
                        thumb_track(b["p2"][finger], "p2", sgn * a2, scale)]
                continue
            out += [track(b["root"][finger], sgn * a0, scale), track(b["p1"][finger], sgn * a1, scale), track(b["p2"][finger], sgn * a2, scale)]
    out.append("        </LinearAnimation>\n")
    return "".join(out)


TRANSITION = f'''                    <StateTransition stateToId="{STATE_ID}" duration="12">
                        <TransitionViewModelCondition>
                            <TransitionPropertyViewModelComparator>
                                <BindablePropertyTrigger>
                                    <DataBindContext sourcePathIds="0:9100-{TRIG_ID}" propertyKey="686"/>
                                </BindablePropertyTrigger>
                            </TransitionPropertyViewModelComparator>
                            <TransitionValueTriggerComparator/>
                        </TransitionViewModelCondition>
                    </StateTransition>
'''
STATE = f'''                <AnimationState x="720" y="1860" animationId="{ANIM_ID}" id="{STATE_ID}">
                    <StateTransition stateToId="0:222" duration="18" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/>
                </AnimationState>
'''


def main(scale: float = 1.0, out: Path = SCENE) -> None:
    s = SCENE.read_text(encoding="utf-8")
    if TRIG_ID in s:
        raise SystemExit("fist clip already present in scene.rml (restore it first: git checkout scene.rml)")
    s = s.replace('        <ViewModelPropertyTrigger name="stretch" id="0:290"/>\n',
                  f'        <ViewModelPropertyTrigger name="stretch" id="0:290"/>\n        <ViewModelPropertyTrigger name="fist" id="{TRIG_ID}"/>\n', 1)
    s = s.replace('            <ViewModelInstanceTrigger viewModelPropertyId="0:290"/>\n',
                  f'            <ViewModelInstanceTrigger viewModelPropertyId="0:290"/>\n            <ViewModelInstanceTrigger viewModelPropertyId="{TRIG_ID}"/>\n', 1)
    # animation: right before the first state machine (after the last LinearAnimation)
    last = s.rfind("</LinearAnimation>\n") + len("</LinearAnimation>\n")
    s = s[:last] + animation(scale) + s[last:]
    # transition: after the stretch transition inside the rest state
    m = re.search(r'(<StateTransition stateToId="0:430" duration="12">.*?</StateTransition>\n)', s, re.S)
    s = s[:m.end()] + TRANSITION + s[m.end():]
    # state: after the stretch AnimationState
    m = re.search(r'<AnimationState x="720" y="1800" animationId="0:330" id="0:430">.*?</AnimationState>\n', s, re.S)
    s = s[:m.end()] + STATE + s[m.end():]
    out.write_text(s, encoding="utf-8")


if __name__ == "__main__":
    sc = float(sys.argv[sys.argv.index("--scale") + 1]) if "--scale" in sys.argv else 1.0
    main(sc)
