#!/usr/bin/env python3
"""ROUND45b — keep viseme mouth shapes attached during R44 head yaw (same offset as g.mouth)."""
import re
import round43_face_yaw_motion as M43
import round44_eye_yaw_motion as M44  # noqa: F401 — applies R44 EXTRA on import

_mouth = M43.EXTRA.get("full.head.g.mouth", 2.0)
M43.EXTRA = dict(M43.EXTRA)
M43.EXTRA["full.mouth.shapes"] = _mouth
for v in ("a", "i", "u", "e", "o", "m"):
    M43.EXTRA[f"full.mouth.viseme.{v}.image"] = _mouth


def rest_xy_any(s, n):
    t = re.search(rf'<(?:RootBone|Image) name="{re.escape(n)}"[^>]*>', s)
    if t is None:
        raise KeyError(n)
    tag = t.group(0)
    return (
        float(re.search(r'\bx="([-\d.]+)"', tag).group(1)),
        float(re.search(r'\by="([-\d.]+)"', tag).group(1)),
    )


M43.rest_xy = rest_xy_any

if __name__ == "__main__":
    M43.main()
