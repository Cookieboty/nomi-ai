#!/usr/bin/env python3
"""ROUND20 Task B — wave bent-elbow readability (handoff §6 item 6).

Tried dedicated bent Solo art rebound at wave-peak FK + 1.55 rad re-warp: arm
detaches / floats (same failure mode as R6). Mesh rebuild of hang sleeve with
harder crease B=10 broke rest (~100k px) — reverted.

Safe path that keeps brand-check and does not regress rest/clap/other clips:
  * keep hang Solo
  * on full.wave only, add forearm scaleY foreshortening at the raised hold
    (1 → 0.82 → 1) so the ~90° FK bend reads as a joint instead of a stretched
    rubber hose in front view
  * slightly deepen peak fore relative bend (-1.68 → -1.78) via rebaking the
    absolute fore/hand tracks from the relative recipe in animate-fullbody

Actually we only patch scaleY on full.arm-r.fore (and hand follows as child of
fore's scale in Rive? — hand is independent RootBone, so only fore mesh
compresses). Also key scaleY on upper? No — keep upper.

Idempotent: strips prior fore scaleY keys on full.wave then re-adds.
"""
from __future__ import annotations

import re

import round10_layers as L10
import round13_anim as A
import round8_scene as R8

SCENE = L10.PROJECT / "scene.rml"
FORE = "full.arm-r.fore"
# foreshortening curve (frame, scaleY)
SCALE_KEYS = [
    (0, 1.0),
    (10, 0.96),
    (22, 0.88),
    (32, 0.84),
    (42, 0.80),
    (52, 0.82),
    (62, 0.80),
    (72, 0.84),
    (84, 0.92),
    (98, 0.98),
    (108, 1.0),
]


def strip_prop(scene: str, anim: str, obj_id: str, prop: str) -> str:
    a, b = R8.find_elem(scene, "LinearAnimation", anim)
    body = scene[a:b]
    def repl(m):
        block = m.group(0)
        block2 = re.sub(
            rf'\n?\s*<KeyedProperty property="{re.escape(prop)}">.*?</KeyedProperty>',
            "",
            block,
            flags=re.S,
        )
        # if object left empty of properties, drop it
        if "<KeyedProperty" not in block2:
            return ""
        return block2
    body = re.sub(
        rf'\n?\s*<KeyedObject objectId="{re.escape(obj_id)}">.*?</KeyedObject>',
        repl,
        body,
        flags=re.S,
    )
    return scene[:a] + body + scene[b:]


def main():
    scene = SCENE.read_text(encoding="utf-8")
    ids = A.ids_by_name(scene)
    fid = ids[FORE]
    scene = strip_prop(scene, "full.wave", fid, "scaleY")
    # also strip scaleX if we ever added
    scene = strip_prop(scene, "full.wave", fid, "scaleX")
    xml = A.linear_track(fid, "scaleY", SCALE_KEYS)
    # cubic ease would be nicer but linear_track is fine / consistent with hair
    scene = A.add_to_anim(scene, "full.wave", xml)
    if "ROUND20 wave-bent" not in scene:
        scene = scene.replace(
            "<!-- ROUND7-FULL-DECOMPOSE -->\n",
            "<!-- ROUND7-FULL-DECOMPOSE -->\n    <!-- ROUND20 wave-bent: fore scaleY foreshortening (bent Solo still tears) -->\n",
            1,
        )
    else:
        scene = scene.replace(
            "<!-- ROUND20 wave-bent: hang sleeve harder elbow crease B=10 (bent Solo still tears) -->\n",
            "<!-- ROUND20 wave-bent: fore scaleY foreshortening (bent Solo still tears) -->\n",
            1,
        )
        scene = scene.replace(
            "<!-- ROUND20 wave-bent: dedicated bent sleeve art rebound at wave peak -->\n",
            "<!-- ROUND20 wave-bent: fore scaleY foreshortening (bent Solo still tears) -->\n",
            1,
        )
    SCENE.write_text(scene, encoding="utf-8")
    build = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = build.read_text()
    if "round20_wave_bent" not in bt:
        build.write_text(bt.rstrip() + "\npython3 round20_wave_bent.py\n")
    print("ROUND20 wave-bent: fore scaleY foreshortening", SCALE_KEYS[4])


if __name__ == "__main__":
    main()
