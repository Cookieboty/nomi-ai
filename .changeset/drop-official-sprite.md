---
'@nomi-ai/renderer': patch
---

feat(mascot): the official character no longer ships the 2D layered sprite (about 3 MB). When the Rive animation cannot start, the desktop character falls back to its static image; packs without a static image still fall back to their sprite.
