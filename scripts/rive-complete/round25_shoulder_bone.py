#!/usr/bin/env python3
"""ROUND25b - shoulder (deltoid/clavicle helper) bone + graded torso->shoulder->upper-arm skin.

R22/R23 skinned the shoulder pieces on only TWO bones (torso, upper arm).  Linear-blend skinning of one ~95 deg wave
rotation across a single band collapses the band (cos(theta/2) shrink at w=0.5) and leaves a 23 deg kink in the
material lines just above the joint (flow.py: wave f040-f072 TURN 22-24 deg at t=-30).
Now:
  * full.arm-X.shoulder: new bone, child of full.arm-X.rig, at the glenohumeral centre G (same as the R25 upper
    pivot), rest rotation = upper rest; every clip that keys the upper arm gets shoulder keys
    rot = rest + K * (upper - rest) (K = 0.5), so the cap takes half the swing and each blend band only spans half
    the angle.  The upper-arm bone chain is NOT re-parented: elbow/hand motion is unchanged.
  * weights (artboard px around G; t along the rest arm axis, d lateral, + = outward):
      torso  1 above t=-75 .. 0 at t=-30          (chest / clavicle stays put)
      upper  0 at t=-5   .. 1 at t=+45           (arm below the humeral head rides the arm)
      shoulder = the rest (deltoid cap band, peaks at t~-15..0)
      medial strip (d < -22 .. -42 -> torso, faded out over t=-10..+20) keeps the chest/armpit skin on the torso.
  * shoulder-skin mesh density 6 -> 4 px cells (smoother graded band).  coat lining/dark stay 100 % torso (R22).
Run after round25_shoulder_pivot.py.  Idempotent via MARK."""
from __future__ import annotations
import math, re
from PIL import Image
import round8_scene as R8
import round13_anim as A
import round10_layers as L10
import round21_arm_fk as FK
import round25_shoulder_pivot as P25

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
MARK = "<!-- ROUND25 shoulder-bone -->"
TORSO = (480.0, 660.0)
K = 0.65
PIECES = {"shoulder-skin": 4.0, "sleeve-stump": 6.0, "coat-shoulder": 6.0}


def weights(t, d):
    wt = 1.0 - R8.smooth01((t + 80.0) / 40.0)
    wu = R8.smooth01((t + 30.0) / 55.0)
    # medial -> torso, only around/above the joint (fades out by t=+20 so the inner sleeve down the arm follows it)
    lat = R8.smooth01((-d - 22.0) / 20.0) * (1.0 - R8.smooth01((t + 10.0) / 30.0))
    wt = max(wt, lat)
    wu = wu * (1.0 - wt)
    ws = max(0.0, 1.0 - wt - wu)
    return [wt, ws, wu]


def main():
    scene = SCENE.read_text(encoding="utf-8")
    assert P25.MARK in scene, "run round25_shoulder_pivot.py first"
    if MARK in scene:
        print("already applied"); return
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    ids = A.ids_by_name(scene)
    tq = ids["full.torso"]
    for s in ("l", "r"):
        rx, ry, _ = FK.bone_attrs(scene, f"full.arm-{s}.rig")
        ux, uy, ur = FK.bone_attrs(scene, f"full.arm-{s}.upper")
        uid = ids[f"full.arm-{s}.upper"]
        sid = R8.nid("bone")
        m = re.search(rf'<RootBone name="full.arm-{s}.rig"[^>]*>', scene)
        scene = scene[:m.end()] + (f'<RootBone name="full.arm-{s}.shoulder" x="{ux:.4f}" y="{uy:.4f}" rotation="{ur:.6f}" '
                                   f'length="1" scaleX="1" id="{sid}"></RootBone>') + scene[m.end():]
        n_an = 0
        for an, (dur, tr) in A.animations(scene).items():
            tu = tr.get(uid, {}).get("rotation")
            if not tu:
                continue
            scene = A.add_to_anim(scene, an, FK.track(sid, "rotation", [(f, ur + K * (v - ur)) for f, v, _ in tu]))
            n_an += 1
        G = (rx + ux, ry + uy)
        ax, ay = math.cos(ur), math.sin(ur)
        out = 1.0 if s == "r" else -1.0
        c, si = math.cos(ur), math.sin(ur)

        def wf(x, y):
            dx, dy = x - G[0], y - G[1]
            t = dx * ax + dy * ay
            d = dx * out  # outward = +x for r, -x for l (arm hangs ~vertical)
            return weights(t, d)
        for p, cell in PIECES.items():
            nm = f"full.arm-{s}.{p}.static"
            a, b = R8.find_elem(scene, "Image", nm)
            tag = scene[a:b]
            iid = re.search(r' id="([^"]+)"', tag[:tag.index(">")]).group(1)
            asset = re.search(r'assetId="([^"]+)"', tag).group(1)
            f = re.search(rf'<ImageAsset [^>]*file="([^"]+)" id="{asset}"', scene).group(1)
            w, h = Image.open(PROJECT / f).size
            vx = [float(v) for v in re.findall(r'<(?:Contour)?MeshVertex x="([-\d.]+)"', tag)]
            vy = [float(v) for v in re.findall(r'<(?:Contour)?MeshVertex x="[-\d.]+" y="([-\d.]+)"', tag)]
            mesh = R8.grid_mesh(nm, (min(vx), min(vy)), (w, h), (cell, cell), wf, [(tq, TORSO), (sid, G), (uid, G)])
            for bid in (sid, uid):
                mesh = re.sub(rf'(<Tendon boneId="{bid}") xx="1.000000" xy="0.000000" yx="0.000000" yy="1.000000"',
                              rf'\1 xx="{c:.6f}" xy="{si:.6f}" yx="{-si:.6f}" yy="{c:.6f}"', mesh)
            xml = (f'<Image name="{nm}" assetId="{asset}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" '
                   f'id="{iid}">{mesh}</Image>')
            scene = scene[:a] + xml + scene[b:]
            print(s, p, "verts", xml.count("MeshVertex x=") , "bbox", round(min(vx),1), round(min(vy),1), round(max(vx),1), round(max(vy),1))
        print(s, "shoulder bone", sid, "keyed in", n_an, "clips")
    scene = scene.replace(P25.MARK, P25.MARK + "\n    " + MARK, 1)
    SCENE.write_text(scene, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round25_shoulder_bone" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round25_shoulder_bone.py\n")


if __name__ == "__main__":
    main()
