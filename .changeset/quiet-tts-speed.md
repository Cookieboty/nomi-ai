---
'@nomi-ai/electron': patch
'@nomi-ai/renderer': patch
'@nomi-ai/types': patch
---

Remove system speech fallback from TTS and pass the active character speed setting to the local sherpa model. TTS failures now stay silent.
