---
'@nomi-ai/renderer': patch
---

fix(tts): a stale TTS request that fails late no longer stops or revokes the sentence that is currently playing; each sentence owns its audio / url / audio graph, and a cancel during `AudioContext.resume()` no longer attaches the envelope or plays.
