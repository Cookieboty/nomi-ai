---
'@nomi-ai/electron': patch
'@nomi-ai/renderer': patch
'@nomi-ai/ai-chat': patch
---

fix(character-pack): runtime overlay (Scheme B) packs whose id is not `nomi` now play their prompt clips and get the character voice defaults; sprite-mode packs (and the Rive→sprite fallback) load the pack's own sprite; a static pack that ships only `character.png` loads it instead of 404; the bundled empty `resources/character-pack` placeholder no longer logs a warning on every launch; the prompt-clip manifest waits for the overlay so it is never cached from the wrong pack; the bubble anchors to the whole character box (same base as hitboxes) in sprite-rig mode; onboarding no longer flashes the built-in art before the pack's art.
