#!/usr/bin/env python3
"""ROUND17 — idle auto-blink.

Adds a looping LinearAnimation `full.idle-blink` that keys only the R14 eye bones (full.eye2.<s>.ball scaleY,
full.eye2.<s>.lash y/scaleY; same closure mapping as full.blink, head untouched) and plays it on its own state-machine
layer `full.autoblink`, inserted between `full.idle` and `Actions`.  Layers later in the list win, so an explicit
`full.blink` (or any future action keying the eye bones) on `Actions` still overrides the auto-blink.
Rest keys use the bones' exact rest values, so non-blink frames are pixel-identical to the R16 build.
Timeline (60 fps, 15 s loop): blinks at 3.0 s, 7.0 s, a double blink at 11.5 s (+0.32 s), loop -> next at 18.0 s,
i.e. gaps 3.0 / 4.0 / 4.5 / 3.5 s.  Idempotent."""
from __future__ import annotations

import re
from pathlib import Path

SCENE = Path(__file__).resolve().parents[2] / "rive/nomi-complete/scene.rml"
FPS, DUR = 60, 900
STARTS = [180, 420, 690, 709]                 # 709 = second half of the double blink
SHAPE = [(0, 0.0), (6, 1.0), (8, 1.0), (17, 0.0)]  # close 100 ms, hold 33 ms, open 150 ms (~280 ms total)
EYES = {  # ball id, lash id, lash rest y (exact bone rest), lash closed y (= full.blink key)
    "l": ("0:45363", "0:45364", -17.4388, -1.3952),
    "r": ("0:45366", "0:45367", -18.1512, -1.4520),
}
ANIM_ID, LAYER_ID, STATE_ID = "0:60001", "0:60002", "0:60003"
EASE = '<CubicEaseInterpolator x1="0.42" y1="0" x2="0.58" y2="1"/>'


def track(fn):
    pts = [(0, fn(0.0))]
    for s in STARTS:
        for f, c in SHAPE:
            if pts and s + f <= pts[-1][0]:
                pts[-1] = (pts[-1][0], fn(c))  # merge overlap (double blink)
                continue
            pts.append((s + f, fn(c)))
    pts.append((DUR, fn(0.0)))
    return "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="cubic">{EASE}</KeyFrameDouble>' for f, v in pts)


def keyed(oid, prop, fn):
    return f'            <KeyedObject objectId="{oid}"><KeyedProperty property="{prop}">{track(fn)}</KeyedProperty></KeyedObject>\n'


def main():
    s = SCENE.read_text(encoding="utf-8")
    s = re.sub(r'\n\s*<LinearAnimation name="full\.idle-blink".*?</LinearAnimation>', "", s, flags=re.S)
    s = re.sub(r'\n\s*<StateMachineLayer name="full\.autoblink".*?</StateMachineLayer>', "", s, flags=re.S)
    body = ""
    for ball, lash, y0, y1 in EYES.values():
        body += keyed(ball, "scaleY", lambda c: 1.0 - 0.94 * c)
        body += keyed(lash, "y", lambda c, y0=y0, y1=y1: y0 + (y1 - y0) * c)
        body += keyed(lash, "scaleY", lambda c: 1.0 - 0.4 * c)
    anim = (f'\n        <LinearAnimation name="full.idle-blink" loopValue="loop" duration="{DUR}" fps="{FPS}" id="{ANIM_ID}">\n'
            f'{body}        </LinearAnimation>')
    m = re.search(r'<LinearAnimation name="full\.blink".*?</LinearAnimation>', s, re.S)
    s = s[:m.end()] + anim + s[m.end():]
    layer = (f'\n            <StateMachineLayer name="full.autoblink" id="{LAYER_ID}">\n'
             '                <AnyState x="0" y="-100"/>\n                <ExitState x="400" y="-100"/>\n'
             f'                <EntryState>\n                    <StateTransition stateToId="{STATE_ID}"/>\n                </EntryState>\n'
             f'                <AnimationState x="200" y="0" animationId="{ANIM_ID}" id="{STATE_ID}"/>\n'
             '            </StateMachineLayer>')
    m = re.search(r'<StateMachineLayer name="full\.idle".*?</StateMachineLayer>', s, re.S)
    s = s[:m.end()] + layer + s[m.end():]
    SCENE.write_text(s, encoding="utf-8")
    print("ROUND17 autoblink: blinks at", [round(x / FPS, 2) for x in STARTS], "s, loop", DUR / FPS, "s")


if __name__ == "__main__":
    main()
