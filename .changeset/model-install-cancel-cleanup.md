---
'@nomi-ai/electron': patch
---

fix(models): cancelling a model-store install while its thumbnail is downloading no longer leaves the fully downloaded VRM behind on disk, and an update whose thumbnail switched between PNG and JPG removes the old thumbnail.
