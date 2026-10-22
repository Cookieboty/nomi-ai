#!/usr/bin/env python3
"""ROUND37b - run: real running fist + screen-right fist never sinks into the belt pouch.

1. Fist.  R26 baked the run fingers as 0.35 x full.fist (MCP ~40 deg, PIP ~18, DIP ~22): a loose open hand with the
   fingers hanging out, not a fist.  R37b uses the validated full.fist pose (same per-bone curl direction, so both hands
   curl toward the palm, no mirror sign error) scaled per segment to a relaxed running fist:
   MCP x0.85 (~98 deg on the 115 deg fist key), PIP x1.0 (~52), DIP x1.0 (~63); thumb x1.0 (rests across the index middle phalanx).
   Envelope = run envelope (fist forms during the ramp-in and opens in the settle).
2. Pouch.  full.belt.pouch.image is declared inside full.arm-r.rig ABOVE coat-r.front / sleeve-r / hand-r (first
   declared draws on top), so on the forward pump the screen-right fist (arm-r) passed BEHIND the pouch (~1000 px of
   the fist hidden inside the pouch, f32-46 / f72-86).  A DrawRules on the pouch with two targets:
     rest   = before full.coat-r.front.image  (identical to the tree order -> idle / walk / every other clip unchanged)
     behind = after  full.hand-r.thumb.image  (pouch under the whole arm-r chain)
   full.run keys drawTargetId (KeyFrameId, hold): behind from f0, rest on the last frame.
Idempotent: strips its own DrawRules + run finger / drawTarget keys and rebuilds."""
from __future__ import annotations
import re
import round13_anim as A
import round10_layers as L10
import round8_scene as R8
import round26_gait as G

SCENE = L10.PROJECT / "scene.rml"
FING = G.FING if hasattr(G, "FING") else ("thumb", "index", "middle", "ring", "little")
SEGS = G.SEGS if hasattr(G, "SEGS") else ("", ".1", ".2")
SEG_K = {"": 0.85, ".1": 1.0, ".2": 1.0}
THUMB_K = 1.0
RULES = "full.belt.pouch.drawrules"


def max_id(s):
    return max(int(x) for x in re.findall(r'id="0:(\d+)"', s))


def main():
    s = SCENE.read_text(encoding="utf-8")
    # ---- strip previous R37b state
    s = re.sub(r'<DrawRules name="' + re.escape(RULES) + r'".*?</DrawRules>', "", s, flags=re.S)
    ids = A.ids_by_name(s)
    an = A.animations(s)
    fist = {}
    for sd in "lr":
        for fg in FING:
            for sg in SEGS:
                n = f"full.arm-{sd}.{fg}{sg}"
                k = an["full.fist"][1].get(ids[n], {}).get("rotation", [])
                fist[n] = max((x[1] for x in k), key=abs, default=0.0)
    m = re.search(r'(<LinearAnimation name="full\.run"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
    dur = int(m.group(2)); body = m.group(3)
    own = {ids[n] for n in fist}
    body = re.sub(r'\s*<KeyedObject objectId="(0:\d+)"><KeyedProperty property="rotation">(?:<KeyFrameDouble [^>]*/>)*</KeyedProperty></KeyedObject>',
                  lambda k: "" if k.group(1) in own else k.group(0), body)
    body = re.sub(r'\s*<KeyedObject objectId="0:\d+"><KeyedProperty property="drawTargetId">.*?</KeyedProperty></KeyedObject>', "", body, flags=re.S)
    frames = list(range(0, dur + 1, 2)) + ([dur] if dur % 2 else [])
    add = []
    for n, v in fist.items():
        kk = THUMB_K if ".thumb" in n else SEG_K[n[len(n.rstrip('.12')):] if n[-2:] in ('.1', '.2') else ""]
        kf = "".join(f'<KeyFrameDouble value="{kk * G.run_frame(f)["env"] * v:.6f}" frame="{f}" interpolationType="linear"/>' for f in frames)
        add.append(f'\n            <KeyedObject objectId="{ids[n]}"><KeyedProperty property="rotation">{kf}</KeyedProperty></KeyedObject>')
    # ---- pouch draw rules
    nid = max_id(s) + 1
    rid, t_rest, t_beh = f"0:{nid}", f"0:{nid + 1}", f"0:{nid + 2}"
    rules = (f'<DrawRules name="{RULES}" drawTargetId="{t_rest}" id="{rid}">'
             f'<DrawTarget name="pouch.rest" drawableId="{ids["full.coat-r.front.image"]}" placementValue="before" id="{t_rest}"/>'
             f'<DrawTarget name="pouch.behind-arm-r" drawableId="{ids["full.hand-r.thumb.image"]}" placementValue="after" id="{t_beh}"/>'
             '</DrawRules>')
    add.append(f'\n            <KeyedObject objectId="{rid}"><KeyedProperty property="drawTargetId">'
               f'<KeyFrameId value="{t_beh}" frame="0" interpolationType="hold"/><KeyFrameId value="{t_rest}" frame="{dur}" interpolationType="hold"/>'
               '</KeyedProperty></KeyedObject>')
    s = s[:m.start(3)] + body + "".join(add) + s[m.end(3):]
    a, b = R8.find_elem(s, "Image", "full.belt.pouch.image")
    el = s[a:b]
    el = el[:-len("</Image>")] + rules + "</Image>" if el.endswith("</Image>") else el[:-2] + ">" + rules + "</Image>"
    s = s[:a] + el + s[b:]
    SCENE.write_text(s, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round37_run_fist" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip("\n") + "\npython3 round37_run_fist.py\n")
    print(f"ROUND37b run fist: {len(fist)} finger tracks, pouch DrawRules {rid} rest={t_rest} behind={t_beh}")


if __name__ == "__main__":
    main()
