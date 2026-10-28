---
'@nomi-ai/host-electron': patch
---

fix(character): custom character packs that loaded on 2.0.5 load again instead of silently falling back to Nomi; an id with capitals, an extra or out-of-range hitbox, an empty display name or artboard, or an invalid persona / mapping / locale file now only logs a warning for runtime overlay packs.
