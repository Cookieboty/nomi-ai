---
'@nomi-ai/gateway': patch
---

fix(models): learned model limits (for example a lowered reasoning level) now stop applying when they expire after 7 days, even if the gateway config didn't change in the meantime. Before, a cached result could keep the old limit until restart (#138).
