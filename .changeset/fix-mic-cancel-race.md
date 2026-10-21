---
'@nomi-ai/voice': patch
---

fix(voice): cancelling (release / cancel / unmount / stop) while the microphone or VAD is still starting now sticks — a late `getUserMedia` stream is released immediately, no recording starts, and an old start can no longer change the state of a newer one.
