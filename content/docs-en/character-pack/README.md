# Character Pack (Single-Character Skin Replacement)

The product ships with **one** complete character at a time. The official character, Nomi, is just an ordinary character pack: [`characters/nomi`](../../characters/nomi).
Skinning means selecting another pack at build time (`CHARACTER_PACK=<dir>`) or placing an override pack at runtime; files in the repository are never modified.

> **Third-party / forks: read [REPLACING.md](./REPLACING.md) first** (creating a pack, validation, building, runtime overrides, remote assets).

## Quick start

```bash
# Validate the official characters/nomi pack (complete voice assets required)
pnpm character:check

# Validate any pack
pnpm character:check -- characters/test-dummy

# Create a new pack from the template (static mode, placeholder art)
pnpm character:init -- ../my-character.pack my-character

# Pre-build check: validate the pack to be bundled (read-only; modifies no files)
CHARACTER_PACK=../my-character.pack pnpm character:apply

# Build with this pack (renderer / ai-chat read the pack directly)
CHARACTER_PACK=../my-character.pack pnpm build
```

## Design highlights

1. **Default pack = `characters/nomi`**: When `CHARACTER_PACK` is unset, the build ships the official Nomi pack. Official and third-party packs follow the exact same loading and validation path.
2. **Build time**: `scripts/character/vite-plugin.mjs` reads the selected pack—serving pack files directly at `/character/…` in development, and emitting them to `renderer/dist/character/` (the full pack) and `ai-chat/dist/character/onboarding/` (onboarding illustrations) during builds; it also generates `assets/models/model-list.json` and `virtual:character-pack` (normalized pack data). Paths are no longer overwritten in place, and `character.generated.json` is gone.
3. **Runtime**: `CharacterPackService` resolves `userData/character-pack` → `resources/character-pack` → the built-in pack, activating the first pack that passes `validatePack` (`@nomi-ai/character-contract`). In packaged builds the built-in pack is at `resources/renderer/character`; in development it is `CHARACTER_PACK` or `characters/nomi` in the repository.
4. **Persona and character copy travel with the pack**: `persona.json` + `locales/{zh,en}.json`. The identity section of the system prompt, greetings, and mascot tips are all read from the active pack; `pnpm check:i18n` checks `zh` / `en` parity for every pack.
5. Single character; no store or switcher UI; UI themes, `appId`, and the product name stay out of the pack.
6. The region id is `hem` (`skirt` is no longer used); voice clips use stable ids (see [`voice-ids.json`](../../packages/character-contract/voice-ids.json)), with legacy key aliases retained for one release.
7. Large assets can be declared as remote (`assets.remote`) and downloaded by the app on demand; the official pack's `.riv` is a remote asset.
8. `static` mode is a first-class citizen; the stand-in pack [`characters/test-dummy`](../../characters/test-dummy) uses it to verify that replacing the character removes all Nomi references.

## Documentation

- **[REPLACING.md](./REPLACING.md) — Third-party skinning / replacement guide (start here)**
- [CONTRACT.md](./CONTRACT.md) — Contract specification
- [contract.json](../../packages/character-contract/contract.json) / [voice-ids.json](../../packages/character-contract/voice-ids.json) — Machine-readable contract (`@nomi-ai/character-contract`, including schemas, `validatePack`, and migration helpers)
- [designer-checklist.md](./designer-checklist.md) — Designer delivery checklist
- Packs: `characters/nomi` (official), `characters/test-dummy` (stand-in), `examples/static-demo.pack` (static-image example)
