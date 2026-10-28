---
'@nomi-ai/core': patch
---

fix(core): `currentCoreScope()` falls back to the only live core when called outside any scope (host callbacks), so `t()` keeps the user's language; with several live cores it keeps the process default.
