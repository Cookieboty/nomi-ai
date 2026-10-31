---
'@nomi-ai/host-electron': patch
---

fix(windows): when a settings or state file is briefly locked by antivirus or the indexer, saving no longer freezes the app for up to 2 seconds. The write retries in the background on a timer instead of sleeping on the main process, later saves to the same file land after it, and quitting still waits for pending saves (#154).
