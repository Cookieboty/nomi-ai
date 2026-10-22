#!/usr/bin/env python3
"""ROUND27 helpers: scene hierarchy + forward kinematics over baked clips, mesh texel <-> local mapping."""
from __future__ import annotations
import math, re
import numpy as np
import round13_anim as A

XF = ("Node", "RootBone", "Bone", "Solo", "Image")


def hierarchy(scene: str) -> dict:
    """name -> dict(id, tag, parent(name), x, y, r, sx, sy) for transform components inside the artboard."""
    out, stack = {}, []
    for m in re.finditer(r'<(/?)(Node|RootBone|Bone|Solo|Image|Mesh|Artboard)\b([^>]*?)(/?)>', scene):
        cl, tag, attr, sc = m.groups()
        if cl:
            if stack:
                stack.pop()
            continue
        nm = re.search(r'\bname="([^"]+)"', attr)
        g = lambda k, d: float(re.search(rf'\b{k}="([-\d.eE+]+)"', attr).group(1)) if re.search(rf'\b{k}="', attr) else d
        name = nm.group(1) if nm else f"?{m.start()}"
        if tag in XF:
            par = next((s for s in reversed(stack) if s and s in out), None)
            out[name] = dict(id=re.search(r'\bid="([^"]+)"', attr).group(1) if ' id="' in attr else None, tag=tag, parent=par,
                             x=g("x", 0.0), y=g("y", 0.0), r=g("rotation", 0.0), sx=g("scaleX", 1.0), sy=g("scaleY", 1.0))
        if not sc:
            stack.append(name if tag in XF else None)
    return out


def mat(x, y, r, sx, sy):
    c, s = math.cos(r), math.sin(r)
    return np.array([[c * sx, -s * sy, x], [s * sx, c * sy, y], [0, 0, 1.0]])


class FK:
    def __init__(self, scene: str):
        self.h = hierarchy(scene)
        self.an = A.animations(scene)

    def local(self, name, anim, f):
        n = self.h[name]
        tr = self.an[anim][1].get(n["id"], {}) if anim else {}
        g = lambda p, d: A.eval_track(tr[p], f) if p in tr else d
        return mat(g("x", n["x"]), g("y", n["y"]), g("rotation", n["r"]), g("scaleX", n["sx"]), g("scaleY", n["sy"]))

    def world(self, name, anim=None, f=0):
        M = np.eye(3)
        while name:
            M = self.local(name, anim, f) @ M
            name = self.h[name]["parent"]
        return M


def angle(M):
    return math.atan2(M[1, 0], M[0, 0])


def mesh_vertices(tag: str):
    """[(x, y, u, v)] of an image mesh (local coords of the image's parent)."""
    return np.array([(float(a), float(b), float(c), float(d)) for a, b, c, d in
                     re.findall(r'<(?:Contour)?MeshVertex x="([-\d.]+)" y="([-\d.]+)" u="([-\d.]+)" v="([-\d.]+)"', tag)])


def uv_to_xy(V, uv):
    """piecewise-linear interpolation of the mesh's rest map uv -> xy (scipy griddata, nearest outside hull)."""
    from scipy.interpolate import griddata
    xy = np.stack([griddata(V[:, 2:4], V[:, i], uv, method="linear") for i in (0, 1)], -1)
    bad = np.isnan(xy[:, 0])
    if bad.any():
        xy[bad] = np.stack([griddata(V[:, 2:4], V[:, i], uv[bad], method="nearest") for i in (0, 1)], -1)
    return xy
