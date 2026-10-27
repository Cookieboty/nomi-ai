---
'@nomi-ai/electron': patch
---

perf(win): more settings and state files (startup view, delegate settings, auto-update toggle, price cache, delegate tasks, session accounts, privacy log) save asynchronously, so a file briefly locked by antivirus or the indexer on Windows no longer freezes the app while the save retries. Quitting waits for pending saves to finish (#154).
