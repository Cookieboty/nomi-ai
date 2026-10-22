"""ROUND9 hand rig definition: finger joint chains (mother px) + soft capsule skin weights for one continuous hand Mesh."""
from __future__ import annotations

import math

import numpy as np

# joints in mother pixels: MCP, PIP, DIP, tip.  radius = capsule half width (mother px)
JOINTS = {
    "l": {
        "thumb":  dict(pts=[(302, 768), (306, 788), (313, 806), (319, 824)], r=11.0),
        "index":  dict(pts=[(327, 762), (327, 777), (326, 790), (325, 800)], r=6.8),
        "middle": dict(pts=[(326, 790), (333, 786), (338, 783), (342, 781)], r=4.6),
        "ring":   dict(pts=[(326, 795), (333, 795), (338, 795), (342, 795)], r=4.6),
        "little": dict(pts=[(326, 800), (332, 803), (337, 806), (341, 808)], r=4.6),
    },
    "r": {
        "thumb":  dict(pts=[(717, 770), (713, 789), (706, 806), (698, 821)], r=11.0),
        "index":  dict(pts=[(686, 762), (686, 777), (687, 790), (688, 800)], r=6.8),
        "middle": dict(pts=[(689, 791), (682, 787), (677, 783), (673, 780)], r=4.6),
        "ring":   dict(pts=[(689, 795), (682, 795), (677, 795), (673, 795)], r=4.6),
        "little": dict(pts=[(689, 800), (683, 803), (678, 806), (674, 808)], r=4.6),
    },
}
# wrist centre (mother px) = centre of the skin edge right under the cuff band: the hand bone pivots here
WRIST = {"l": (317.5, 743.0), "r": (702.0, 742.0)}
FINGERS = ("thumb", "index", "middle", "ring", "little")


def smooth01(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def _seg_proj(p, a, b):
    ab = (b[0] - a[0], b[1] - a[1])
    L2 = ab[0] ** 2 + ab[1] ** 2
    t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2 if L2 else 0.0
    t = min(1.0, max(0.0, t))
    q = (a[0] + ab[0] * t, a[1] + ab[1] * t)
    return t, math.hypot(p[0] - q[0], p[1] - q[1])


def finger_influence(side: str, name: str, mx: float, my: float, mcp_ramp: float = 5.0, joint_blend: float = 4.0):
    """-> (a, [w_root, w_mid, w_dist]) ; a = how much this finger owns the pixel (0..1)"""
    f = JOINTS[side][name]
    pts = f["pts"]
    r = f["r"]
    best = None
    s0 = 0.0
    seglens = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(3)]
    for i in range(3):
        t, d = _seg_proj((mx, my), pts[i], pts[i + 1])
        if best is None or d < best[0]:
            best = (d, s0 + t * seglens[i])
        s0 += seglens[i]
    d, s = best
    soft = 4.0
    a = float(1.0 - smooth01((d - r) / soft))
    # ramp in from the palm: the MCP end is held by the hand bone
    # signed distance along the first segment direction before MCP
    a0, a1 = pts[0], pts[1]
    ux, uy = a1[0] - a0[0], a1[1] - a0[1]
    ln = math.hypot(ux, uy) or 1.0
    along = ((mx - a0[0]) * ux + (my - a0[1]) * uy) / ln   # <0: palm side of MCP
    a *= float(smooth01((along + mcp_ramp) / (2 * mcp_ramp)))
    S1, S2 = seglens[0], seglens[0] + seglens[1]
    u1 = float(smooth01((s - S1 + joint_blend) / (2 * joint_blend)))
    u2 = float(smooth01((s - S2 + joint_blend) / (2 * joint_blend)))
    return a, [1.0 - u1, u1 - u2, u2]


WRIST_RAMP = 14.0   # mother px over which the wrist skin blends from "rigid with the forearm" to "rigid with the hand"


def weights_at(side: str, mx: float, my: float) -> list[float]:
    """[hand, thumb0..2, index0..2, middle0..2, ring0..2, little0..2, fore] (17 values, sum=1)

    The wrist stub + first rows follow the *forearm* bone exactly like the cuff band does (cuff band bottom is ~100%
    fore), then blend into the hand bone, so the junction never opens a wedge when the hand flexes against the arm.
    """
    wf = 1.0 - float(smooth01((my - (WRIST[side][1] - 1.0)) / WRIST_RAMP))
    infl = [finger_influence(side, n, mx, my) for n in FINGERS]
    tot = sum(a for a, _ in infl)
    scale = 1.0 / tot if tot > 1.0 else 1.0
    out = [max(0.0, 1.0 - tot * scale)]
    for a, seg in infl:
        out += [a * scale * s for s in seg]
    out = [w * (1.0 - wf) for w in out]
    out.append(wf)
    return out
