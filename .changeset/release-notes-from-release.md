---
'@nomi-ai/ai-chat': patch
'@nomi-ai/host-electron': patch
---

fix(updates): the What's new panel shows the notes of the version you are running instead of the 2.0.5 notes. They come from that version's release (docs/releases/vX.Y.Z.md, delivered in its latest-go.json), are cached for offline use, follow the UI language, and fall back to a GitHub Releases link when they can't be fetched.
