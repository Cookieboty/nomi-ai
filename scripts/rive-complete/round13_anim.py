#!/usr/bin/env python3
"""ROUND13 helpers: evaluate baked keyframes of scene.rml (for secondary-motion baking) + small xml/key writers.

eval_track(keys, frame): keys = [(frame, value, interp)], interp in {"linear", "cubic", "hold"}; cubic = the
CubicEaseInterpolator on the *starting* key (every cubic key of this scene uses (0.42, 0, 0.58, 1))."""
from __future__ import annotations

import math
import re

EASE = (0.42, 0.0, 0.58, 1.0)


def _bez(t, a, b):
    return 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3


def ease(x, c=EASE):
    lo, hi = 0.0, 1.0
    for _ in range(40):
        m = (lo + hi) / 2
        if _bez(m, c[0], c[2]) < x:
            lo = m
        else:
            hi = m
    return _bez((lo + hi) / 2, c[1], c[3])


def eval_track(keys, f):
    if not keys:
        return None
    if f <= keys[0][0]:
        return keys[0][1]
    for (f0, v0, it), (f1, v1, _) in zip(keys, keys[1:]):
        if f0 <= f <= f1:
            if f1 == f0 or it == "hold":
                return v0 if f < f1 else v1
            x = (f - f0) / (f1 - f0)
            if it == "cubic":
                x = ease(x)
            return v0 + (v1 - v0) * x
    return keys[-1][1]


def ids_by_name(scene: str) -> dict:
    return {m.group(1): m.group(2) for m in re.finditer(r'<(?:RootBone|Bone|Node|Image|Solo)\b[^>]*?\bname="([^"]+)"[^>]*?\bid="(0:\d+)"', scene)}


def animations(scene: str) -> dict:
    """{anim name: (duration, {object id: {prop: [(frame, value, interp)]}})}"""
    out = {}
    for m in re.finditer(r'<LinearAnimation name="([^"]+)"[^>]*?duration="(\d+)"[^>]*>(.*?)</LinearAnimation>', scene, re.S):
        tracks = {}
        for k in re.finditer(r'<KeyedObject objectId="(0:\d+)">(.*?)</KeyedObject>', m.group(3), re.S):
            for p in re.finditer(r'<KeyedProperty property="(\w+)">(.*?)</KeyedProperty>', k.group(2), re.S):
                keys = [(int(fr), float(v), it) for v, fr, it in
                        re.findall(r'<KeyFrameDouble value="([-\d.eE+]+)" frame="(\d+)" interpolationType="(\w+)"', p.group(2))]
                tracks.setdefault(k.group(1), {})[p.group(1)] = sorted(keys)
        out[m.group(1)] = (int(m.group(2)), tracks)
    return out


def linear_track(obj_id: str, prop: str, frames_vals) -> str:
    kf = "".join(f'<KeyFrameDouble value="{v:.6f}" frame="{f}" interpolationType="linear"/>' for f, v in frames_vals)
    return f'<KeyedObject objectId="{obj_id}"><KeyedProperty property="{prop}">{kf}</KeyedProperty></KeyedObject>'


def add_to_anim(scene: str, anim: str, xml: str) -> str:
    m = re.search(rf'<LinearAnimation name="{re.escape(anim)}"[^>]*>', scene)
    close = scene.index("</LinearAnimation>", m.end())
    return scene[:close] + xml + "\n        " + scene[close:]


RESERVED_LO, RESERVED_HI = 60001, 60133


class Ids:
    def __init__(self, scene: str, base_offset: int = 1):
        top = max(int(x) for x in re.findall(r'\bid="0:(\d+)"', scene))
        # 0:60001..0:60133 is a reserved block of hard-coded ids (R17 autoblink, R18 step/squat,
        # R26 walk/run clips + states).  Dynamic allocation must never land inside it, otherwise a
        # clean rebuild (where R26 has not run yet when R19..R25 allocate) collides with R26's ids.
        if RESERVED_LO <= top <= RESERVED_HI:
            top = RESERVED_HI
        self.n = top + base_offset

    def __call__(self) -> str:
        self.n += 1
        return f"0:{self.n}"


def pose_xform(tracks: dict, pose_id: str, f: float):
    """full.pose node transform at frame f -> function p -> world (translate * rotate * scale, origin 0,0)."""
    t = tracks.get(pose_id, {})
    g = lambda p, d: (eval_track(t[p], f) if p in t else d)
    x, y, r, sx, sy = g("x", 0.0), g("y", 0.0), g("rotation", 0.0), g("scaleX", 1.0), g("scaleY", 1.0)
    c, s = math.cos(r), math.sin(r)
    return (lambda p: (x + c * sx * p[0] - s * sy * p[1], y + s * sx * p[0] + c * sy * p[1])), r
