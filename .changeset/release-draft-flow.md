---
'@nomi-ai/electron': patch
---

ci(release): tag builds check the tag equals `v${version}`, create one draft Release from `docs/releases/<tag>.md` before packaging, and publish only after every installer and blockmap listed in latest*.yml is attached (#146).
