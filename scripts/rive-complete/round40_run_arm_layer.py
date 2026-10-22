#!/usr/bin/env python3
"""ROUND40 - run: the forward-pumping forearm + hand draw IN FRONT of the puffy sleeve / coat.

R40 swings the arms fore-aft (round28_armswing.run_pose_r40): on the forward swing the forearm points toward the camera
and up, so in a front view the cuff + hand are in front of the upper sleeve.  The tree order (first declared = on top)
has full.arm-X.cuff + every hand image BELOW upper-skin / coat-X.front / sleeve-X (correct for a hanging arm).
Fix: the contiguous block cuff .. hand-X.thumb.image is wrapped in an identity Node full.arm-X.handLayer with a DrawRules
  rest  = after  full.arm-X.under-skin.image   (exactly the tree slot -> idle / walk / every other clip unchanged)
  front = before full.arm-X.upper-skin.image   (top of the arm chain; first-declared = on top)
full.run keys drawTargetId (hold): front while the forearm points up / at the camera (cos(theta+phi) < FRONT_COS),
rest otherwise and on f0 / the last frame.  Idempotent (unwraps and rebuilds)."""
from __future__ import annotations
import math, re
import round13_anim as A
import round10_layers as L10
import round8_scene as R8
import round26_gait as G
import round28_armswing as AS

SCENE = L10.PROJECT / "scene.rml"
FRONT_COS = 0.25


def max_id(s):
    return max(int(x) for x in re.findall(r'id="0:(\d+)"', s))


def main():
    s = SCENE.read_text(encoding="utf-8")
    for sd in "lr":                                   # unwrap a previous R40 layer
        m = re.search(rf'<Node name="full\.arm-{sd}\.handLayer"[^>]*>(<DrawRules .*?</DrawRules>)?', s, re.S)
        if m:
            e = s.find("</Node><!--r40-->", m.end())
            s = s[:m.start()] + s[m.end():e] + s[e + len("</Node><!--r40-->"):]
    m = re.search(r'(<LinearAnimation name="full\.run"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
    body = re.sub(r'\s*<KeyedObject objectId="0:\d+"><!--r40--><KeyedProperty property="drawTargetId">.*?</KeyedProperty></KeyedObject>', "", m.group(3), flags=re.S)
    s = s[:m.start(3)] + body + s[m.end(3):]
    ids = A.ids_by_name(s)
    nid = max_id(s) + 1
    keys = []
    for sd in "lr":
        a, _ = R8.find_elem(s, "Image", f"full.arm-{sd}.cuff.image")
        _, b = R8.find_elem(s, "Image", f"full.hand-{sd}.thumb.image")
        blk = s[a:b]
        assert "<Node" not in blk and "</Node>" not in blk, sd
        node, rid, tr, tf = (f"0:{nid + i}" for i in range(4)); nid += 4
        rules = (f'<DrawRules name="full.arm-{sd}.handLayer.rules" drawTargetId="{tr}" id="{rid}">'
                 f'<DrawTarget name="hand-{sd}.rest" drawableId="{ids[f"full.arm-{sd}.under-skin.image"]}" placementValue="after" id="{tr}"/>'
                 f'<DrawTarget name="hand-{sd}.front" drawableId="{ids[f"full.arm-{sd}.upper-skin.image"]}" placementValue="before" id="{tf}"/>'
                 '</DrawRules>')
        s = s[:a] + f'<Node name="full.arm-{sd}.handLayer" x="0" y="0" id="{node}">' + rules + blk + "</Node><!--r40-->" + s[b:]
        keys.append((sd, rid, tr, tf))
    m = re.search(r'(<LinearAnimation name="full\.run"[^>]*duration="(\d+)"[^>]*>)(.*?)(\s*</LinearAnimation>)', s, re.S)
    dur = int(m.group(2)); add = ""; log = {}
    for sd, rid, tr, tf in keys:
        kf, last, fr = "", None, []
        for f in range(dur + 1):
            g, env = AS.phase("run", f)
            a = AS.arm_pose("run", g, env, sd)
            front = 0 < f < dur and math.cos(a["th"] + a["phi"]) < FRONT_COS and env > 0.3
            if front != last:
                kf += f'<KeyFrameId value="{tf if front else tr}" frame="{f}" interpolationType="hold"/>'; last = front
            if front:
                fr.append(f)
        add += (f'\n            <KeyedObject objectId="{rid}"><!--r40--><KeyedProperty property="drawTargetId">{kf}'
                '</KeyedProperty></KeyedObject>')
        log[sd] = (fr[0], fr[-1], len(fr)) if fr else None
    s = s[:m.end(3)] + add + s[m.end(3):]
    SCENE.write_text(s, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round40_run_arm_layer" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip("\n") + "\npython3 round40_run_arm_layer.py\n")
    print("ROUND40 hand layer (front frames first,last,count):", log)


if __name__ == "__main__":
    main()
