# character-pack (extraResources)

This directory is copied into the packaged app as `resources/character-pack`
(see `packages/host-electron/electron-builder.yml` → `extraResources`).

Resolve order (CharacterPackService):

1. `{userData}/character-pack/`
2. `{resources}/character-pack/` ← this folder when a full pack is placed here
3. the built-in pack: `{resources}/renderer/character/` — the pack the renderer build shipped
   (`characters/nomi`, or `CHARACTER_PACK` at build time)

Leave empty (or only this README) for official builds. To ship a white-label
overlay with the installer, drop a **complete** pack (manifest + onboarding +
mode assets) into this directory — not a store, not multi-character.
