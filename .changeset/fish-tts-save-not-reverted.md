---
'@nomi-ai/electron': patch
---

fix(electron): choosing the local Fish voice engine with the default address (127.0.0.1:8080, `nomi`, mp3) in advanced voice settings and saving no longer silently switches back to the built-in Sherpa voice. The old-default migration now only applies to config files written by earlier versions (no schema version), and runs once.
