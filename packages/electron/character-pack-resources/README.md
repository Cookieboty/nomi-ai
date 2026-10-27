# character-pack (extraResources)

This directory is copied into the packaged app as `resources/character-pack`
(see `packages/electron/electron-builder.yml` → `extraResources`).

Scheme B resolve order:

1. `{userData}/character-pack/`
2. `{resources}/character-pack/` ← this folder when a full pack is placed here
3. built-in official character

Leave empty (or only this README) for official builds. To ship a white-label
overlay with the installer, drop a **complete** pack (manifest + onboarding +
mode assets) into this directory — not a store, not multi-character.
