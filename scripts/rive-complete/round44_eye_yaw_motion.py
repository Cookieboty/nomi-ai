#!/usr/bin/env python3
"""ROUND44b — modestly stronger head turn (after round44_eye_split).

Re-runs the R43 rigid-face motion with larger feature offsets now that the eyes carry their own
eyelid/skin zone (full.head.g.eyes): eyes (eye2 parts + eye zone + brows, identical both sides,
no scaleX) 3.5 px, nose 4.5 px, mouth 3 px; bangs/clip stay at 1 px, face otherwise rigid.
Keys are rewritten under the R43 marker (idempotent)."""
import round43_face_yaw_motion as M43

EYES = 3.5
M43.EXTRA = dict(M43.EXTRA)
M43.EXTRA.update({"full.head.g.nose": 4.5, "full.head.g.mouth": 3.0,
                  "full.eye2.l": EYES, "full.eye2.r": EYES, "full.head.g.eyes": EYES,
                  "full.brow.l": EYES, "full.brow.r": EYES})

if __name__ == "__main__":
    M43.main()
