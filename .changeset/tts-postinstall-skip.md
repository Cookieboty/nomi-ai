---
'@nomi-ai/electron': patch
---

chore(tts): the dev postinstall model download is skipped when the model is already complete (file sizes + `.nomi-model.json` version marker), can be disabled with `NOMI_SKIP_MODEL_DOWNLOAD=1`, and is skipped by default on CI (`CI=true`; set `NOMI_SKIP_MODEL_DOWNLOAD=0` to force it).
