# How to Replace / Full-Pack Skinning (Third-Party & Forks)

For white-label builds, fork maintainers, and asset partners: package an installer with your own complete character pack, or override the built-in character at runtime.

> This is not a runtime store or a multi-character switcher UI: only one character is active at a time.

For the full specification, see [CONTRACT.md](./CONTRACT.md) / [contract.json](../../packages/character-contract/contract.json) (`@nomi-ai/character-contract`); for the designer handoff list, see [designer-checklist.md](./designer-checklist.md).

---

## Goals & boundaries

| Item         | Description                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Build time   | `CHARACTER_PACK=<dir> pnpm build`: renderer / ai-chat read this pack directly, bundling your character into the build    |
| Runtime      | Place a complete pack in `userData/character-pack` or `resources/character-pack` to override the built-in pack           |
| Official     | When `CHARACTER_PACK` is **unset**, the build uses `characters/nomi`—following the exact same load and validation path   |
| Non-invasive | Both build and runtime read directly from the pack; repository files are never overwritten, so no cleanup step is needed |
| Single       | The product ships one complete character at a time; no store or switcher UI                                              |

### What is inside vs. outside the pack

**In the pack (replaceable):**

- Appearance: `rive` / `sprite` / `static` (choose one as the primary mode)
- Onboarding illustrations: `onboarding/*.webp` (`welcome` / `profile` / `provider` / `privacy`)
- Voice clips: `voice/<locale>/` (optional; falls back to TTS / silent when absent, with a validation warning)
- Identity: `persona.json` (`displayName`, `shortName`, `pronoun`, `systemPromptIdentity`, `addressUser`, `greetings`, `tips`)—the identity section of the chat system prompt comes solely from here; `pronoun` is used when the UI refers to the character in prose ("click her “AI chat”"), defaulting to "it" when omitted, and specified per language in `locales/en.json` under `persona` (e.g., `"pronoun": "he"`)
- Character copy (lines, tips, greetings, voice subtitles): `locales/zh.json`, `locales/en.json`—travels with the pack rather than the app's global i18n catalog; if a tip line is missing from the pack, the character simply does not say it
- Optional semantic mapping: `mapping.json` (emotion / activity / gesture → engine resource id)
- Optional layout: `manifest.layout` (window size, hitboxes, `bubbleAnchor`; `skirt` is normalized to `hem`)
- Optional attribution: `manifest.credits` (`author` / `license` / `source`), `CREDITS.md`, `LICENSE`
- Legacy formats still readable (with validation warnings): `copy/{zh,en}.json`, `persona/system-prompt.md`, `layout/hitboxes.json`

See [CONTRACT.md](./CONTRACT.md) § `persona.json` / `mapping.json` / `locales` for field details.

**Outside the pack:**

- UI themes / tokens, UI copy
- `appId`, product name, protocol scheme, update channel
- Character store / multi-character switcher UI

---

## Choosing a mode

| `manifest.assets.mode` | Required assets                        | Speed / cost    | Notes                                                       |
| ---------------------- | -------------------------------------- | --------------- | ----------------------------------------------------------- |
| **`static`**           | `static/character.webp` (or `.png`)    | **Fastest**     | No `.riv`, no 43 actions; ideal for verifying the pipeline  |
| **`sprite`**           | `sprite/` layers + `manifest.json`     | Medium          | Can serve as primary mode or fallback for `rive`            |
| **`rive`** (default)   | `rive/character.riv`                   | Highest fidelity| Strongly recommended to also include `sprite/` as fallback  |

`static` is a first-class citizen: `character:check` **skips** `.riv` and 43-action checks. Template: `characters/test-dummy`.

---

## Minimal static pack layout

```text
my-character.pack/
  manifest.json          # schema=1, id, contractVersion=1, assets.mode=static
  static/character.webp  # recommended longest edge >= 1024 px, transparent background
  onboarding/
    welcome.webp
    profile.webp
    provider.webp
    privacy.webp
  persona.json           # recommended: character identity
  locales/zh.json        # recommended: character copy (line keys should match between zh and en)
  locales/en.json        # recommended
```

Optional: `mapping.json`, `manifest.layout`, `static/blink.webp`, `voice/zh/`.

Minimal `manifest.json`:

```json
{
  "schema": 1,
  "id": "my-character",
  "contractVersion": 1,
  "version": "1.0.0",
  "credits": { "author": "You", "license": "CC-BY-4.0", "source": "https://example.com" },
  "assets": { "mode": "static", "static": "static/character.webp", "onboarding": "onboarding" },
  "defaults": { "voiceHint": "xiaoxiao", "voiceRate": 0.9, "voicePitch": 1.08 },
  "layout": { "bubbleAnchor": { "x": 0.5, "y": 0.1 } }
}
```

Example `persona.json` (primary locale) and `locales/en.json`:

```json
{
  "displayName": "Pip",
  "pronoun": "it",
  "systemPromptIdentity": "You are Pip, a robot living in a cardboard box.",
  "greetings": ["Beep!"]
}
```

```json
{
  "persona": {
    "displayName": "Pip",
    "pronoun": "it",
    "systemPromptIdentity": "You are Pip, a robot living in a cardboard box."
  },
  "wakePhrase": "Hi, Pip",
  "lines": { "greet-companion": "Beep! Pip is online." }
}
```

The keys in `lines` are stable clip ids (see `packages/renderer/src/mascot/tips.ts` for the tip ids used by the mascot).

---

## Recommended workflow

### 1. Create a pack

```bash
pnpm character:init -- ../my-character.pack my-character
# Edit the character art, onboarding illustrations, persona.json, locales/, and manifest inside ../my-character.pack
```

For a complete `rive` / voice example, refer to the official pack `characters/nomi` (official brand assets are for reference only and must not be modified; see [Brand Guide](../BRAND.md#9-%E5%93%81%E7%89%8C%E9%94%81)).

### 2. Validate

```bash
pnpm character:check -- ../my-character.pack
```

Expected: `OK` (when a `static` pack has no voice assets, a `voice/zh not provided` warning is allowed). All errors must be resolved.
Validation and runtime share the exact same `validatePack` (`@nomi-ai/character-contract`), so a pack that passes `check` will also load at runtime.

### 3. Build

```bash
CHARACTER_PACK=../my-character.pack pnpm character:apply   # pre-check (read-only)
CHARACTER_PACK=../my-character.pack pnpm build
```

- renderer: emits the full pack to `packages/renderer/dist/character/` and generates `assets/models/model-list.json`; in the installer this becomes `resources/renderer/character`, which the core reads as the built-in pack (persona, copy).
- ai-chat: emits onboarding illustrations to `packages/ai-chat/dist/character/onboarding/`.
- Development mode: `CHARACTER_PACK=../my-character.pack pnpm dev` lets all processes read directly from this pack.

Leave `CHARACTER_PACK` unset to use the official pack—no revert step is required.

### 4. Runtime override (without rebuilding)

Place a **complete** character pack in either location (first match wins):

1. `{userData}/character-pack/` (dev: Electron `app.getPath('userData')`)
2. `{resources}/character-pack/` (installer `extraResources`, source directory `apps/desktop-go/character-pack-resources/`)

Validation failure → logs error → falls back to the built-in pack. Views fetch assets and copy via `character-pack:get-active` and `character-pack://pack/…`.

Runtime override packs use the same contract validation as `character:check`, but are loaded under 2.0.5 compatibility rules (`lenient`):

- **Still rejected** (also rejected in 2.0.5): missing or invalid JSON manifest, `schema` not equal to `1`, empty `id`, unknown mode, `contractVersion` higher than the app supports, missing onboarding illustrations, or missing primary-mode assets (`.riv` for `rive`, `sprite/manifest.json` for `sprite`, or character image for `static`).
- **Warn only, still loaded**: non-structural issues (`NON_STRUCTURAL_ISSUES`: `.riv` smaller than 1000 bytes, declared but missing fallback assets such as `sprite/` in a `rive` pack, voice files without `voice/<locale>/manifest.json`, incomplete voice clips); field-level manifest issues (an `id` outside lowercase letters, digits, `-`, `_` is kept as-is; unknown hitbox ids, out-of-range 0–1 ratios, or `top >= bottom` regions are dropped; empty `displayName`, `rive.artboard`, and other invalid optional fields are dropped); schema-invalid `persona.json` / `mapping.json` / `locales` (file ignored).
  Because 2.0.5 did not validate these, packs that loaded then continue to load now; each issue is logged individually and should be fixed using `pnpm character:check`.

`character:check` and builds (`CHARACTER_PACK=…`) still treat all of these as errors.

---

## Remote assets

Large assets can be declared as remote (manifest `assets.remote`, currently supporting `rive`): they are omitted from the installer and downloaded by the app when the user turns on animation.
The official pack's `.riv` uses this mechanism.

---

## Command reference

| Command                             | Purpose                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm character:check [-- <pack>]`  | Run `validatePackDir`; defaults to `characters/nomi` (requires complete voice assets)                |
| `pnpm character:init -- <dir> [id]` | Create a new pack using `characters/test-dummy` as the template                                      |
| `pnpm character:apply`              | Pre-check the pack to be built (`CHARACTER_PACK` or `characters/nomi`), read-only                    |
| `CHARACTER_PACK=<dir> pnpm build`   | Build with the specified pack                                                                        |
| `pnpm build:stand-in`               | Build with the stand-in pack `characters/test-dummy` (checks that UI does not hardcode official name)|
| `pnpm check:character-leak`         | Verify official character name appears only in `characters/nomi` and brand modules                    |
| `pnpm check:i18n`                   | Check `zh` / `en` parity including `characters/*/locales`                                            |

CI (the `quality` job) runs checks against `characters/nomi`, `characters/test-dummy`, and `examples/static-demo.pack`.

## Out of scope

- Character store / multi-character switcher UI
- Changing `appId`, product name, update channel, or UI themes

For the complete list of fields and action ids, read [CONTRACT.md](./CONTRACT.md).
