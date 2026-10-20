#!/usr/bin/env python3
"""ROUND27 item 2 - rig the split coat front panels on their own chain.

Chain per side (all RootBones, x axis along the panel, rest = bind):
  full.arm-X.upper (attach: the panel hangs off the sleeve's inner edge at the upper arm)
    -> full.coat-X.front     (texel y TOP+4 .. 200, placket)
      -> full.coat-X.front.s1  (200 .. 290, mid panel / trim)
        -> full.coat-X.hem      (290 .. tip, trim end + hem-tail lines)
Graded weights on the (unchanged, rest-exact) panel mesh, by texel row y:
  upper   1 - smooth((y - TOP - 10) / 50)      (top rows ride the sleeve exactly: the seam under the collar never opens)
  fore    0.35 * smooth((y - 230) / 80)      (the forearm nudges the lower panel, which rests against the sleeve)
  front / s1 / hem  smooth blends centred on the joints (y 200, 290, 60 px wide), times the remainder.
The old EMPTY bones full.coat-l.front / full.coat-r.front (children of full.coat-X at the hip, no image, no key) are
deleted; the names are reused by the new chain.  Idempotent (MARK)."""
from __future__ import annotations
import json, math, re
import numpy as np
from PIL import Image
import round8_scene as R8
import round13_anim as A
import round10_layers as L10
import round27_common as C
import round27_coat_split as SP

PROJECT = L10.PROJECT
SCENE = PROJECT / "scene.rml"
MARK = "<!-- ROUND27 coat-rig -->"
JOINT_Y = (200.0, 290.0)
TIP_Y = {"l": 404.0, "r": 352.0}


def centre(side, y):
    a = np.array(Image.open(PROJECT / f"reference/svg-rig/coat-{side}-front.png"))[..., 3]
    rows = range(max(0, int(y) - 6), min(a.shape[0], int(y) + 7))
    xs = np.concatenate([np.nonzero(a[r] > 128)[0] for r in rows])
    return float(np.median(xs)) + 0.5, float(y) + 0.5


FORE = 0.35


def weights(side, ty):
    """[upper, fore, front, s1, hem]"""
    top = SP.TOP[side]
    up = 1.0 - R8.smooth01((ty - top - 10.0) / 50.0)
    fo = FORE * R8.smooth01((ty - 230.0) / 80.0)          # the forearm nudges the lower panel (it rests against the sleeve)
    a = R8.smooth01((ty - JOINT_Y[0] + 30.0) / 60.0)
    b = R8.smooth01((ty - JOINT_Y[1] + 30.0) / 60.0)
    ch = [(1 - a), a * (1 - b), a * b]
    rest = 1.0 - up - fo
    if rest < 0:
        fo, rest = 1.0 - up, 0.0
    return [up, fo] + [rest * c for c in ch]


def pack(ws):
    """top-4 influences -> (values, indices) with 1-based tendon indices"""
    order = sorted(range(len(ws)), key=lambda i: -ws[i])[:4]
    order = [i for i in order if ws[i] > 1e-4]
    tot = sum(ws[i] for i in order)
    vals = [int(round(255 * ws[i] / tot)) for i in order]
    vals[0] += 255 - sum(vals)
    return sum(v << (8 * k) for k, v in enumerate(vals)), sum((i + 1) << (8 * k) for k, i in enumerate(order))


def main():
    scene = SCENE.read_text(encoding="utf-8")
    if MARK in scene:
        print("already applied"); return
    nxt = A.Ids(scene, 3500)
    log = {}
    for s in "lr":
        fk = C.FK(scene)
        a, b = R8.find_elem(scene, "Image", f"full.coat-{s}.front.image")
        tag = scene[a:b]
        V = C.mesh_vertices(tag)
        top = SP.TOP[s]
        ys = [top + 4.0, JOINT_Y[0], JOINT_Y[1], TIP_Y[s]]
        tex = [centre(s, y) for y in ys]
        P = C.uv_to_xy(V, np.array([(x / 225.0, y / 440.0) for x, y in tex]))        # arm-X.rig local
        Rig = fk.world(f"full.arm-{s}.rig")
        Up = np.linalg.inv(Rig) @ fk.world(f"full.arm-{s}.upper")                    # upper in rig space
        names = [f"full.coat-{s}.front", f"full.coat-{s}.front.s1", f"full.coat-{s}.hem"]
        par = Up; xml = ""; binds = []; chain = []
        for j, nm in enumerate(names):
            p0, p1 = P[j], P[j + 1]
            ang_w = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
            loc = np.linalg.inv(par) @ np.array([p0[0], p0[1], 1.0])
            r = ang_w - C.angle(par)
            r = (r + math.pi) % (2 * math.pi) - math.pi
            L = float(np.hypot(*(p1 - p0)))
            bid = nxt()
            chain.append((nm, bid, float(loc[0]), float(loc[1]), r, L))
            par = par @ C.mat(loc[0], loc[1], r, 1, 1)
            binds.append((bid, par.copy()))
        for nm, bid, x, y, r, L in reversed(chain):
            xml = (f'<RootBone name="{nm}" x="{x:.4f}" y="{y:.4f}" rotation="{r:.6f}" length="{L:.4f}" scaleX="1" id="{bid}">'
                   + xml + '</RootBone>')
        # delete the old empty bone (self-closing child of full.coat-X)
        m = re.search(rf'\s*<RootBone name="full\.coat-{s}\.front" [^>]*/>', scene)
        assert m, "old empty coat front bone not found"
        scene = scene[:m.start()] + scene[m.end():]
        m = re.search(rf'<RootBone name="full\.arm-{s}\.upper"[^>]*>', scene)
        scene = scene[:m.end()] + xml + scene[m.end():]
        # re-weight the panel mesh (same vertices)
        a, b = R8.find_elem(scene, "Image", f"full.coat-{s}.front.image")
        tag = scene[a:b]
        ids = A.ids_by_name(scene)
        Fo = np.linalg.inv(Rig) @ fk.world(f"full.arm-{s}.fore")
        tend = [(ids[f"full.arm-{s}.upper"], Up), (ids[f"full.arm-{s}.fore"], Fo)] + binds
        def rew(m):
            ty = float(m.group(2)) * 440.0
            vals, inds = pack(weights(s, ty))
            return m.group(1) + f'<Weight values="{vals}" indices="{inds}"/>'
        tag = re.sub(r'(<(?:Contour)?MeshVertex [^>]*v="([-\d.]+)"[^>]*>)<Weight [^>]*/>', rew, tag)
        tx = "".join(f'<Tendon boneId="{bid}" xx="{M[0,0]:.6f}" xy="{M[1,0]:.6f}" yx="{M[0,1]:.6f}" yy="{M[1,1]:.6f}" '
                     f'tx="{M[0,2]:.4f}" ty="{M[1,2]:.4f}" name="coat-{s}.front.t{k}"/>' for k, (bid, M) in enumerate(tend))
        tag = re.sub(r'(<Skin [^>]*>).*?(</Skin>)', lambda m: m.group(1) + tx + m.group(2), tag, flags=re.S)
        scene = scene[:a] + tag + scene[b:]
        log[s] = dict(joints_rig=[[round(float(v), 2) for v in p] for p in P], bones=[(c[0], round(c[4], 4), round(c[5], 2)) for c in chain])
    m = re.search(r'<!-- ROUND27 coat-split -->', scene)
    scene = scene[:m.end()] + "\n    " + MARK + scene[m.end():]
    SCENE.write_text(scene, encoding="utf-8")
    print(json.dumps(log))
    bt = (L10.ROOT / "scripts/rive-complete/round13_build.sh").read_text()
    if "round27_coat_rig" not in bt:
        (L10.ROOT / "scripts/rive-complete/round13_build.sh").write_text(bt.rstrip() + "\npython3 round27_coat_rig.py\n")


if __name__ == "__main__":
    main()
