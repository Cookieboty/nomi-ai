---
'@nomi-ai/host-electron': patch
---

fix(tray): after switching between two recent models with the same display name (for example the same model under two providers), clicking a tray entry selects the model it shows again instead of the one the menu had before (#212).
