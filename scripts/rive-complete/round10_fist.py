#!/usr/bin/env python3
"""ROUND10 — minimal ``fist`` clip to validate extreme finger curl on the skinned hands.

Adds to scene.rml (idempotent: replaces an earlier ROUND10 fist block):
  * ViewModelPropertyTrigger ``fist`` (0:291) + Default-instance trigger
  * LinearAnimation ``full.fist`` (0:331, 72f @60): both hands, 5 fingers x 3 joints curl to a closed fist, a squeeze
    overshoot (115 %), hold, release.  Only finger bones are keyed (arms stay at the idle pose).
  * AnimationState (0:431) + transition from the ``rest`` state of the Actions layer.

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
