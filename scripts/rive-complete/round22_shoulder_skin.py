#!/usr/bin/env python3
"""ROUND22 - the 8 shoulder pieces (*.static, children of full.root) become skinned meshes on [full.torso, arm-X.upper].

R21 kept them rigid on full.root and baked x/y/rotation keys so they followed the torso; they never followed the arm, so
in a raised-arm clip (wave/cheer/hello) the sleeve stump stayed hanging beside the torso and the shoulder cap did not
stretch over the raised upper arm.  Now (pixels unchanged, same draw depth):
  * tendons: full.torso (rest world (480,660), rot 0) + full.arm-X.upper (rest world = rig + local, rest rotation);
  * weight field in artboard px around the shoulder joint J (R21 pivot): along the rest arm axis t (down the arm) and
    lateral distance d outward from J:  w_upper = smooth((t + 0.6 d): T0->T1); rest is torso.
    => cap/lapel above and medial of the joint stay with the chest, everything down the arm rides the upper bone, a
       smooth band across the joint stretches like a deltoid instead of tearing.
  * the baked follow keys (x/y/rotation of these 8 objects) are removed from every clip: bones drive them now.
Runs after round21_arm_pivot.py; idempotent via MARK."""
from __future__ import annotations

import hashlib
import json
import math
import re

import numpy as np

from PIL import Image

import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
S = R8.S
MARK = "<!-- ROUND22 shoulder-skin -->"
TORSO = (480.0, 660.0)
# ROUND23: the R22 band (s = t + 0.6 d over -20..+30 px) left the stump/cap blended *below* the joint line while the
# sleeve (all upper-arm) starts at t~0 -> at wave f030-f072 the same material point sat up to 17 px apart in the
# stump vs the sleeve and the coat hinged over 24 px (44.6 deg turn per 24 px arc): the '折断' kink under the shoulder.
# Now every piece is 100 % upper-arm from the joint line down (t >= 0, matches the sleeve), and the deltoid/cap blends
# over 100 px above the joint (pure along-axis, no lateral term), so the bend is one wide smooth arc.
T0, T1 = -100.0, 0.0     # ramp on s = t + KD*d (artboard px from joint)
TC0, TC1 = -100.0, 0.0   # coat-shoulder: same band (the lining is split out since R22, so no wedge)
KD = 0.0                 # R22 used 0.6 (lateral share); it left the medial strip on the torso -> shear
PIECES = ["shoulder-skin", "sleeve-stump", "coat-shoulder", "coat-shoulder.lining", "coat-shoulder.dark"]


def bone(scene, name):
    m = re.search(rf'<RootBone name="{re.escape(name)}" x="([-\d.]+)" y="([-\d.]+)" rotation="([-\d.]+)"[^>]*id="(0:\d+)"', scene)
    return float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)


def split_lining(s):
    """mother-crop fix: coat-X-shoulder.png mixes the lapel (hangs on the arm) with the dark jacket lining lying against
    the torso side (exactly the footprint of coat-X-shoulder-dark.png).  Move (not copy) those pixels into
    coat-X-shoulder-lining.png so the lining can stay with the torso while the lapel rides the arm."""
    d = PROJECT / "reference/svg-rig"
    cp, lp = d / f"coat-{s}-shoulder.png", d / f"coat-{s}-shoulder-lining.png"
    c = np.array(Image.open(cp).convert("RGBA"))
    m = np.array(Image.open(d / f"coat-{s}-shoulder-dark.png").convert("RGBA"))[..., 3] > 0
    if not (c[..., 3][m] > 0).any() and lp.exists():
        return 0
    # the lining (drawn just below the lapel) keeps a 2 px copy of the lapel border so bilinear filtering at the cut
    # does not open a see-through seam at rest; the lapel itself loses exactly the lining footprint.
    md = m.copy()
    for _ in range(2):
        md = md | np.roll(md, 1, 0) | np.roll(md, -1, 0) | np.roll(md, 1, 1) | np.roll(md, -1, 1)
    lin = np.where(md[..., None], c, 0).astype(np.uint8)
    c[m] = 0
    Image.fromarray(c).save(cp)
    Image.fromarray(lin).save(lp)
    lic_p = PROJECT / "parts" / "DETAIL_LICENSE.json"
    lic = json.loads(lic_p.read_text())
    for pth in (cp, lp):
        rel = f"reference/svg-rig/{pth.name}"
        e = lic["assets"].get(rel) or {}
        e.update(sha256=hashlib.sha256(pth.read_bytes()).hexdigest(), bytes=pth.stat().st_size, ai_generated=False, in_scene=True,
                 method=e.get("method", "deterministic source-pixel rig layer derived from user supplied full-body mother"))
        lic["assets"][rel] = e
    note = lic.get("note", "")
    if "ROUND22" not in note:
        lic["note"] = (note + " ROUND22: coat-l/r-shoulder dark lining pixels moved into coat-l/r-shoulder-lining (+2 px border copy under the lapel against filtering seams).").strip()
    lic_p.write_text(json.dumps(lic, indent=2) + "\n")
    return int(m.sum())


def main():
    scene = SCENE.read_text(encoding="utf-8")
    if MARK in scene:
        print("ROUND22 already applied"); return
    ids = A.ids_by_name(scene)
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    tq = ids["full.torso"]
    rep = {}
    for s in ("l", "r"):
        rep[f"lining-{s} px moved"] = split_lining(s)
        aid = R8.nid("asset")
        scene = scene.replace(f'<ImageAsset name="fullbody-coat-{s}-shoulder-dark"',
                              f'<ImageAsset name="fullbody-coat-{s}-shoulder-lining" file="reference/svg-rig/coat-{s}-shoulder-lining.png" id="{aid}"/>\n    <ImageAsset name="fullbody-coat-{s}-shoulder-dark"', 1)
        m = re.search(rf'<Image name="full.arm-{s}.coat-shoulder.static"[^>]*?(/>|></Image>)', scene)
        nid = R8.nid("image")
        lin = re.sub(r'name="[^"]+"', f'name="full.arm-{s}.coat-shoulder.lining.static"', m.group(0), count=1)
        lin = re.sub(r'assetId="[^"]+"', f'assetId="{aid}"', lin, count=1)
        lin = re.sub(r' id="[^"]+"', f' id="{nid}"', lin, count=1)
        scene = scene[:m.end()] + "\n                " + lin + scene[m.end():]
        rx, ry, _, _ = bone(scene, f"full.arm-{s}.rig")
        ux, uy, ur, uid = bone(scene, f"full.arm-{s}.upper")
        J = (rx + ux, ry + uy)
        ax, ay = math.cos(ur), math.sin(ur)
        out = 1.0 if s == "r" else -1.0
        def wf(x, y, J=J, ax=ax, ay=ay, out=out):
            dx, dy = x - J[0], y - J[1]
            t = dx * ax + dy * ay
            d = dx * out
            wu = R8.smooth01((t + KD * d - T0) / (T1 - T0))
            return [1.0 - wu, wu]
        for p in PIECES:
            nm = f"full.arm-{s}.{p}.static"
            m = re.search(rf'<Image name="{re.escape(nm)}"[^>]*?(/>|></Image>)', scene)
            tag = m.group(0)
            iid = re.search(r' id="([^"]+)"', tag).group(1)
            asset = re.search(r'assetId="([^"]+)"', tag).group(1)
            px = float(re.search(r' x="([-\d.]+)"', tag).group(1)); py = float(re.search(r' y="([-\d.]+)"', tag).group(1))
            f = re.search(rf'<ImageAsset [^>]*file="([^"]+)" id="{asset}"', scene).group(1)
            w, h = Image.open(PROJECT / f).size
            # the dark lining is the inside of the sleeve opening: it rides the arm entirely (a torso share stretches
            # it into a brown wedge under a raised arm).
            # the lapel/lining hangs from the cap: only a narrow band at the joint line blends, so the lining swings
            # up with the arm (under the sleeve) instead of being sheared into a wedge between torso and arm.
            def wcoat(x, y, J=J, ax=ax, ay=ay):
                t = (x - J[0]) * ax + (y - J[1]) * ay
                wu = R8.smooth01((t - TC0) / (TC1 - TC0))
                return [1.0 - wu, wu]
            wfn = (lambda x, y: [1.0, 0.0]) if p.endswith((".dark", ".lining")) else (wcoat if p.startswith("coat") else wf)
            mesh = R8.grid_mesh(nm, (px, py), (w, h), (6.0, 6.0), wfn, [(tq, TORSO), (uid, J)])
            c, si = math.cos(ur), math.sin(ur)
            mesh = re.sub(rf'(<Tendon boneId="{uid}") xx="1.000000" xy="0.000000" yx="0.000000" yy="1.000000"',
                          rf'\1 xx="{c:.6f}" xy="{si:.6f}" yx="{-si:.6f}" yy="{c:.6f}"', mesh)
            xml = (f'<Image name="{nm}" assetId="{asset}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1" '
                   f'id="{iid}">{mesh}</Image>')
            scene = scene[:m.start()] + xml + scene[m.end():]
            # drop the R21 baked follow keys
            n0 = 0
            for an in A.animations(scene):
                for prop in ("x", "y", "rotation"):
                    a, b = R8.find_elem(scene, "LinearAnimation", an)
                    if f'objectId="{iid}"' in scene[a:b]:
                        n0 += 1
                        body = scene[a:b]
                        def repl(mm, prop=prop):
                            blk = re.sub(rf'\n?\s*<KeyedProperty property="{prop}">.*?</KeyedProperty>', "", mm.group(0), flags=re.S)
                            return blk if "<KeyedProperty" in blk else ""
                        body = re.sub(rf'\n?\s*<KeyedObject objectId="{re.escape(iid)}">.*?</KeyedObject>', repl, body, flags=re.S)
                        scene = scene[:a] + body + scene[b:]
            rep[nm] = (xml.count("MeshVertex") // 2, n0)
    scene = scene.replace("    <!-- ROUND7-FULL-DECOMPOSE assets -->\n", "    " + MARK + "\n    <!-- ROUND7-FULL-DECOMPOSE assets -->\n", 1)
    assert MARK in scene
    SCENE.write_text(scene, encoding="utf-8")
    build = L10.ROOT / "scripts/rive-complete/round13_build.sh"
    bt = build.read_text()
    if "round22_shoulder_skin" not in bt:
        build.write_text(bt.rstrip() + "\npython3 round22_shoulder_skin.py\n")
    for k, v in rep.items():
        print(k, v)


if __name__ == "__main__":
    main()
