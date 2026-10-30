---
'@nomi-ai/host-electron': patch
---

fix(usage): Grok subscription quota saved on disk is only restored when it belongs to the account currently signed in to Grok (salted fingerprint); otherwise it is discarded. Refreshes also drop the previous account's value after a mid-session account switch.
