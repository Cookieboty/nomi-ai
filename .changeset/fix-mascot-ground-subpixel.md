---
'@nomi-ai/electron': patch
---

fix(mascot): after zooming the mascot to a size whose character box ends on a half pixel (e.g. 121%), keeping her feet on the floor no longer rounds the window 1px below the work area (into the taskbar). Standing / landing positions snap the feet to a whole pixel at or just above the floor.
