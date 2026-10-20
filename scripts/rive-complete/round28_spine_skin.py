#!/usr/bin/env python3
"""ROUND28 item 2 - segmented torso skin: hips (pelvis) -> lumbar (full.torso) -> chest (full.spine), neck on the chest.

Before: full.spine existed but nothing was skinned to it; the tank top was a RIGID image on full.torso and every torso
skin (head neck-base, choker, shoulder/sleeve-stump/coat-shoulder caps, neutral + body backfill) used the single torso
tendon, so the trunk could only tilt as one plank.
Now (graded weights by REST WORLD y, smoothstep blends, no hard edge anywhere -> no tear by construction):
  chest share  c(y) = 1 - smooth((y - 330) / 120)   (y <= 330 all chest, y >= 450 all lumbar)
  hips share   a(y) = smooth((y - 560) / 50)        (as R26: y >= 610 all pelvis -> belt / shorts stay on the hips)
  w_pelvis = a,  w_spine = (1 - a) * c,  w_torso = (1 - a) * (1 - c)
  1. full.neck is re-parented under full.spine (y -406.1 -> -186.1, rest world unchanged, same draw sequence) so the
     head / neck / choker stay continuous with the chest.
  2. full.torso.tank.image becomes a 6 px grid mesh under full.torso, skinned torso + spine (+ pelvis, unused at its
     rest y 281..410); same texel placement as the rigid image.
  3. every existing skin that uses the torso tendon gets a spine tendon and each vertex's torso weight is split
     torso/spine by c(y) (belt band: c = 0 there, untouched).
Rest pose is unchanged (all bones at rest -> every skin reproduces the bind).  Idempotent via MARK."""
from __future__ import annotations
import re
import numpy as np
from PIL import Image
import round8_scene as R8
import round13_anim as A
import round10_layers as L10
import round27_common as C

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
MARK = "<!-- ROUND28 spine-skin -->"


def sm(t):
    return R8.smooth01(t)


def shares(y):
    a = sm((y - 560.0) / 50.0); c = 1.0 - sm((y - 330.0) / 120.0)
    return a, (1 - a) * c, (1 - a) * (1 - c)      # pelvis, spine, torso


def main():
    s = SCENE.read_text(encoding="utf-8")
    if MARK in s:
        print("already applied"); return
    nxt = A.Ids(s)
    R8._next.update({k: nxt.n + 1 + 2000 * i for i, k in enumerate(("mesh", "image", "asset", "bone", "anim"))})
    ids = A.ids_by_name(s)
    TQ, SQ, PQ = ids["full.torso"], ids["full.spine"], ids["full.pelvis"]
    h = C.hierarchy(s); fk = C.FK(s)
    wpos = lambda n: fk.world(n)[:2, 2]
    sw, tw = wpos("full.spine"), wpos("full.torso")
    # 1. neck under spine
    a, b = R8.find_elem(s, "RootBone", "full.neck")
    neck = s[a:b]; s = s[:a] + s[b:]
    neck = neck.replace('y="-406.1"', 'y="-186.1"', 1)
    a, b = R8.find_elem(s, "RootBone", "full.spine")
    sp = s[a:b]; assert sp.endswith("/>")
    s = s[:a] + sp[:-2] + ">" + neck + "</RootBone>" + s[b:]
    # 2. tank mesh
    a, b = R8.find_elem(s, "Image", "full.torso.tank.image")
    tag = s[a:b]
    g = lambda k: re.search(rf' {k}="([^"]+)"', tag).group(1)
    f = re.search(rf'<ImageAsset [^>]*file="([^"]+)" id="{g("assetId")}"', s).group(1)
    w, hh = Image.open(PROJECT / f).size
    assert abs(float(g("scaleX")) - R8.S) < 1e-9
    def wt(x, y):
        p, c, t = shares(y + tw[1]); return [t, c, p]
    mesh = R8.grid_mesh("full.torso.tank.image", (float(g("x")), float(g("y"))), (w, hh), (6.0, 6.0), wt,
                        [(TQ, (0.0, 0.0)), (SQ, (0.0, sw[1] - tw[1])), (PQ, (wpos("full.pelvis")[0] - tw[0], wpos("full.pelvis")[1] - tw[1]))])
    xml = (f'<Image name="full.torso.tank.image" assetId="{g("assetId")}" x="0" y="0" originX="0" originY="0" '
           f'scaleX="1" scaleY="1" id="{g("id")}">{mesh}</Image>')
    s = s[:a] + xml + s[b:]
    print(f"tank: {xml.count('MeshVertex x=')} verts, skinned torso/spine/pelvis")
    # 3. split torso weight of existing skins
    for m in list(re.finditer(r'<Image name="([^"]+)"', s)):
        nm = m.group(1)
        if nm in ("full.torso.tank.image", "full.belt.band.image"):
            continue
        a, b = R8.find_elem(s, "Image", nm); tag = s[a:b]
        tend = re.findall(r'<Tendon boneId="([^"]+)"[^>]*/>', tag)
        if TQ not in tend or SQ in tend:
            continue
        assert len(tend) < 4, nm
        ti = tend.index(TQ) + 1; si = len(tend) + 1
        par = h[nm]["parent"]; pw = wpos(par)
        last = list(re.finditer(r'<Tendon [^>]*/>', tag))[-1]
        tq = re.search(r'<Tendon boneId="%s"[^>]*/>' % TQ, tag).group(0)
        ttx, tty = (float(v) for v in re.search(r'tx="([-\d.]+)" ty="([-\d.]+)"', tq).groups())
        spn = (f'<Tendon boneId="{SQ}" xx="1.000000" xy="0.000000" yx="0.000000" yy="1.000000" '
               f'tx="{ttx + sw[0] - tw[0]:.4f}" ty="{tty + sw[1] - tw[1]:.4f}" name="{nm}.t{si - 1}"/>')
        moved = [0, 0.0]
        def rew(v):
            y = float(v.group(2)) + pw[1]
            vals, inds = int(v.group(3)), int(v.group(4))
            ws = [0.0] * si
            for i in range(4):
                vv = (vals >> (8 * i)) & 255; ix = (inds >> (8 * i)) & 255
                if vv and ix:
                    ws[ix - 1] += vv / 255.0
            _, c, _ = shares(y)
            cc = 1.0 - R8.smooth01((y - 330.0) / 120.0)
            d = ws[ti - 1] * cc
            ws[ti - 1] -= d; ws[si - 1] += d
            if d > 0:
                moved[0] += 1; moved[1] = max(moved[1], d)
            pv, pi = R8.pack_weights(ws)
            return f'{v.group(1)}<Weight values="{pv}" indices="{pi}"/>'
        tag2 = re.sub(r'(<(?:Contour)?MeshVertex x="[-\d.]+" y="([-\d.]+)"[^>]*>)<Weight values="(\d+)" indices="(\d+)"/>', rew, tag)
        tag2 = tag2.replace(last.group(0), last.group(0) + spn, 1)
        s = s[:a] + tag2 + s[b:]
        print(f"{nm}: +spine tendon, {moved[0]} verts moved weight to spine (max {moved[1]:.2f})")
    m = re.search(r'<!-- ROUND26 secondary-skin -->', s)
    s = s[:m.end()] + "\n    " + MARK + s[m.end():]
    SCENE.write_text(s, encoding="utf-8")
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round28_spine_skin" not in bt:
        bt = bt.replace("python3 round28_armswing.py\n", "python3 round28_armswing.py\npython3 round28_spine_skin.py\n")
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt)


if __name__ == "__main__":
    main()
