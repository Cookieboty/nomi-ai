---
'@nomi-ai/host-electron': patch
---

fix(mascot): when the mascot is resized and clamped to the bottom of the screen, the window no longer ends up 1px below the work area under fractional display scaling (125% / 150% / 175% on Windows). The clamp now accounts for the display scale factor and the OS's DIP ⇄ physical pixel rounding.
