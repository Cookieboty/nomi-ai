---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

fix(updates): when the newest Release doesn't have this platform's `latest*.yml` yet (the version is still being published), "Check for updates" now says a new version is being published and to check again later, instead of showing a 404 error. Tag builds now upload to a draft Release that CI publishes only after all three platforms are uploaded (#146).
