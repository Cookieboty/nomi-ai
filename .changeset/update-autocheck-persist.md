---
'@nomi-ai/electron': patch
---

fix(electron): turning off "check for updates automatically" is now remembered across restarts. Previously the switch only lived in memory, so the next launch checked again after ~15 s and auto-downloaded any update. Manual "Check for updates" is unchanged.
