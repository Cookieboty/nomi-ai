---
'@nomi-ai/host-electron': patch
---

fix(windows): saving the chat background no longer freezes the app while Windows briefly locks the settings file (antivirus or indexer). The save retries on a timer instead of blocking the main process; changes made in quick succession are written in order and a failed save still rolls back (#154).
