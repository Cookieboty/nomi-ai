#!/usr/bin/env python3
"""ROUND26 item 4 - last non-skinned soft parts onto bones.

1. hair.l / hair.r (side-hair outline slivers, 1304 / 503 visible px) were RIGID on their own bones full.hair.l/r,
   which no clip ever keyed: they stayed welded to the head while the side locks next to them swung (R13/R20 chains).
   Now each is a skinned grid mesh (6 px) under full.head on the SAME tendons as the adjacent lock
   (head, hair.lock.X.s1..s3); every vertex copies the inverse-distance-weighted (k=4) skin weights of the nearest
   lock mesh vertices, so outline and lock move as one sheet (no tear by construction).  Rest pixels are identical
   (same texel placement).  The empty bones full.hair.l/r are deleted.
2. full.neutral (edge scraps, keyed visible in idle/rest) and full.body.backfill (torso fill behind the tank) hung on
   the full.pose NODE, not on a bone, so torso sway (idle/wave/nod/bow/hop/step...) slid the tank over a static fill.
   Both become skinned meshes (40x16 px cells) on torso (y <= 560) -> pelvis (y >= 610) with a smoothstep between; ids and
   assets kept so the idle/rest opacity keys still apply.
Idempotent via MARK."""
from __future__ import annotations
import re
import numpy as np
from PIL import Image
import round8_scene as R8
import round13_anim as A
import round10_layers as L10

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
MARK = "<!-- ROUND26 secondary-skin -->"
S = R8.S


def mesh_weights(tag):
    """lock mesh -> (xy array, weight matrix [n, k tendons]), tendon list"""
    tend = re.findall(r'<Tendon boneId="([^"]+)"[^>]*tx="([-\d.]+)" ty="([-\d.]+)"', tag)
    xs, W = [], []
    for x, y, vals, inds in re.findall(r'<(?:Contour)?MeshVertex x="([-\d.]+)" y="([-\d.]+)"[^>]*><Weight values="(\d+)" indices="(\d+)"', tag):
        vals, inds = int(vals), int(inds)
        w = np.zeros(len(tend))
        for i in range(4):
            v = (vals >> (8 * i)) & 255; ix = (inds >> (8 * i)) & 255
            if v and ix:
                w[ix - 1] += v / 255.0
        xs.append((float(x), float(y))); W.append(w)
    return np.array(xs), np.array(W), [(b, (float(tx), float(ty))) for b, tx, ty in tend]


def main():
    scene = SCENE.read_text(encoding="utf-8")
    if MARK in scene:
        print("already applied"); return
    nxt = A.Ids(scene)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    ids = A.ids_by_name(scene)
    for s in "lr":
        a, b = R8.find_elem(scene, "Image", f"full.hair.lock.{s}.image")
        P, W, tend = mesh_weights(scene[a:b])
        a, b = R8.find_elem(scene, "RootBone", f"full.hair.{s}")
        bone = scene[a:b]
        bx, by = (float(v) for v in re.search(r'x="([-\d.]+)" y="([-\d.]+)"', bone).groups())
        img = re.search(r'<Image name="full.hair.%s.image"[^>]*>' % s, bone).group(0)
        ix, iy = (float(v) for v in re.search(r' x="([-\d.]+)" y="([-\d.]+)"', img).groups())
        asset = re.search(r'assetId="([^"]+)"', img).group(1); iid = re.search(r' id="([^"]+)"', img).group(1)
        f = re.search(rf'<ImageAsset [^>]*file="([^"]+)" id="{asset}"', scene).group(1)
        w, h = Image.open(PROJECT / f).size
        def wf(x, y):
            d = np.hypot(P[:, 0] - x, P[:, 1] - y); k = np.argsort(d)[:4]
            ww = 1.0 / (d[k] + 1.0) ** 2
            return list((W[k] * ww[:, None]).sum(0) / ww.sum())
        mesh = R8.grid_mesh(f"full.hair.{s}.image", (bx + ix, by + iy), (w, h), (6.0, 6.0), wf, tend)
        xml = (f'<Image name="full.hair.{s}.image" assetId="{asset}" x="0" y="0" originX="0" originY="0" '
               f'scaleX="1" scaleY="1" id="{iid}">{mesh}</Image>')
        scene = scene[:a] + xml + scene[b:]          # replaces the (now deleted) rigid bone in the same draw slot
        print(f"hair.{s}: {xml.count('MeshVertex x=')} verts on {len(tend)} lock tendons; bone full.hair.{s} deleted")
    tq, pq = ids["full.torso"], ids["full.pelvis"]
    def wt(x, y):
        u = R8.smooth01((y - 560.0) / 50.0)
        return [1.0 - u, u]
    for nm in ("full.neutral", "full.body.backfill"):
        a, b = R8.find_elem(scene, "Image", nm)
        tag = scene[a:b]
        g = lambda k: re.search(rf' {k}="([^"]+)"', tag).group(1)
        f = re.search(rf'<ImageAsset [^>]*file="([^"]+)" id="{g("assetId")}"', scene).group(1)
        w, h = Image.open(PROJECT / f).size
        op = f' opacity="{g("opacity")}"' if ' opacity="' in tag else ""
        mesh = R8.grid_mesh(nm, (float(g("x")), float(g("y"))), (w, h), (40.0, 16.0), wt, [(tq, (480.0, 660.0)), (pq, (480.0, 610.0))])
        xml = (f'<Image name="{nm}" assetId="{g("assetId")}" x="0" y="0" originX="0" originY="0" scaleX="1" scaleY="1"'
               f'{op} id="{g("id")}">{mesh}</Image>')
        scene = scene[:a] + xml + scene[b:]
        print(f"{nm}: skinned torso/pelvis, {xml.count('MeshVertex x=')} verts")
    m = re.search(r'<!-- ROUND26 fingers -->', scene)
    scene = scene[:m.end()] + "\n    " + MARK + scene[m.end():]
    SCENE.write_text(scene, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round26_secondary_skin" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round26_secondary_skin.py\n")


if __name__ == "__main__":
    main()
