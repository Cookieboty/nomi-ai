---
'@nomi-ai/renderer': patch
---

fix(voice): after push-to-talk (or another line) interrupts a spoken AI reply, later sentences of that same reply are no longer read aloud while the text keeps streaming. The next reply is read as usual (#148).
