# Character Pack Contract (v1)

Freeze list for a single character pack. Pack authors replace content;
clip / action / file **names** stay stable unless the contract bumps.

The official character is an ordinary pack, [`characters/nomi`](../../characters/nomi): with no
`CHARACTER_PACK` the build ships it, through the same loading path as any third-party pack.

Third-party skinning steps: [`REPLACING.md`](./REPLACING.md).

## Source of truth

The contract lives in the [`@nomi-ai/character-contract`](../../packages/character-contract/README.md) package:

| File                                                                 | Content                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`contract.json`](../../packages/character-contract/contract.json)   | Machine-readable contract (modes, clip / action ids, hitbox ids, semantic vocabulary, file names) |
| [`voice-ids.json`](../../packages/character-contract/voice-ids.json) | Stable voice clip ids ⇄ legacy i18n keys                                                          |
| `src/schemas.ts`                                                     | zod schemas + types for `manifest.json`, `persona.json`, `mapping.json`, `locales/*.json`         |
| `validatePack()` / `validatePackDir()` (`/node`)                     | Structured errors / warnings + normalized pack                                                    |
| `migrate*()`                                                         | Pure migrations (`skirt → hem`, legacy voice keys, legacy `copy/` / `persona/` / `layout/` files) |

Packs contain **data only** — no code. Engines are app-side plugins selected by `assets.mode`.

## Pack layout

```text
my-character.pack/
  manifest.json        id, contractVersion, assets.mode, capabilities, layout
  persona.json         displayName, systemPromptIdentity, addressUser?, greetings[], tips?
  mapping.json         semantic emotion / activity / gesture → engine resource ids (optional)
  locales/zh.json      character copy: lines, wakePhrase, persona overrides
  locales/en.json
  rive/ sprite/ static/
  voice/<locale>/manifest.json + {id}.mp3
  onboarding/{welcome,profile,provider,privacy}.webp
  CREDITS.md / LICENSE
```

`manifest.credits` (`{ author, license, source }`, optional) feeds the bundled model list and the
licence check; the official pack must carry an allow-listed licence.

## manifest.json

| Field                 | Required | Notes                                                                                      |
| --------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `schema`              | yes      | `1`                                                                                        |
| `id`                  | yes      | lowercase letters, digits, `-`, `_` (≤ 64)                                                 |
| `contractVersion`     | yes\*    | integer; packs newer than the app's `CHARACTER_CONTRACT_VERSION` are rejected              |
| `assets.mode`         | yes\*    | `rive` (default) / `sprite` / `static`                                                     |
| `assets.*`            | no       | relative paths inside the pack (`rive`, `sprite`, `static`, `voice`, `onboarding`)         |
| `capabilities`        | no       | `riveMotions`, `spriteActions`, `voiceClipIds`, `lipSync`, `blink`; runtime degrades       |
| `layout.window`       | no       | `{ width, height }` in px                                                                  |
| `layout.hitboxes`     | no       | `{ head \| face \| body \| hand \| hem: { top, bottom, left, right } }`, ratios of the box |
| `layout.bubbleAnchor` | no       | `{ x, y }`, ratios of the box                                                              |
| `rive`                | no       | `{ artboard, stateMachine }` overrides                                                     |
| `catalog`             | no       | model-list entry: `displayName`, `description`, `author`, `tags`, `version`, `lastUpdated` |

\* Filled in by migration for legacy packs: `contractVersion` from `engines.nomiPack` (else `1`),
top-level `mode` moves to `assets.mode`, `layout/hitboxes.json` (`{ regions, bubbleAnchor }`)
merges into `manifest.layout`.

## persona.json

The single source of the character's identity (system prompt identity, greetings).
Product name / appId stay in the host brand and are never taken from the pack.

```json
{
  "displayName": "诺米",
  "systemPromptIdentity": "你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。",
  "addressUser": "你",
  "greetings": ["你好呀，今天想聊点什么？"],
  "tips": ["记得多喝水。"]
}
```

`displayName`, `systemPromptIdentity` and `greetings` are required (`greetings` may be empty —
validation warns). Per-language overrides go in `locales/<lang>.json` → `persona`.
Legacy packs without `persona.json` are migrated from `copy/<lang>.json` and
`persona/system-prompt.md` (first non-empty line), with a warning.

## mapping.json

AI and character only exchange **semantic** events; the pack maps them to its own resources.
Values are one resource id or a list (runtime picks one). Unmapped names are skipped.

```json
{
  "emotions": { "happy": "smile_02", "sad": ["tears", "sigh"] },
  "activities": { "thinking": "think", "toolRunning": "typing_loop" },
  "gestures": { "wave": "wave", "thumbsUp": "thumbs_up" }
}
```

Vocabulary (`contract.json` → `mapping`):

| Section      | Names                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `emotions`   | `neutral` `happy` `sad` `angry` `surprised` `shy` `confused` `sleepy`                                              |
| `activities` | `idle` `thinking` `toolRunning`                                                                                    |
| `gestures`   | `wave` `greet` `nod` `shakeHead` `bow` `clap` `cheer` `celebrate` `thumbsUp` `apologize` `think` `explain` `heart` |

Unknown names and targets not declared in `capabilities` produce warnings, not errors.

## locales/

Character copy (lines, prompts, voice subtitles) **belongs to the pack**, not the app's
global i18n catalog. Primary locale `zh`; `zh` and `en` are both recommended.

```json
{
  "persona": { "displayName": "Nomi", "systemPromptIdentity": "You are Nomi, …" },
  "wakePhrase": "Hi, Nomi",
  "lines": { "greet-hello": "Hi, I'm Nomi!", "tip-ask-me-anything": "Ask me anything." }
}
```

`lines` keys are stable voice clip ids (legacy i18n keys resolve via `voice-ids.json`). The mascot's
tips and greetings (`packages/renderer/src/mascot/tips.ts` lists which ids it uses) are read from
here; a pack without a line stays silent there instead of falling back to another character.
`pnpm check:i18n` checks that every pack under `characters/` has the same lines (and persona
identity fields) in `zh` and `en`. At run time lines fall back to the primary locale. Validation warns when a non-primary locale misses keys
present in `zh`. Legacy `copy/<lang>.json` (`displayName`, `wakePhrase`, `systemPromptIdentity`)
is migrated with a warning.

## Modes

| `manifest.assets.mode` | Required assets                  | Notes                                                 |
| ---------------------- | -------------------------------- | ----------------------------------------------------- |
| `rive` (default)       | `rive/character.riv`             | Primary path; sprite strongly recommended as fallback |
| `sprite`               | `sprite/` layered rig            | May be primary or fallback                            |
| `static`               | `static/character.webp` (or png) | No `.riv`, no 43 actions required                     |

## Rive

| Field         | Default (Nomi)       | Override                     |
| ------------- | -------------------- | ---------------------------- |
| Artboard      | `Nomi-full`          | `manifest.rive.artboard`     |
| State machine | `NomiFull`           | `manifest.rive.stateMachine` |
| File          | `rive/character.riv` | `manifest.assets.rive`       |

Native motion clip names: see `contract.json` → `rive.nativeMotions`.
Missing clips may be listed under `manifest.capabilities.riveMotions` omissions;
runtime skips unknown ids.

## Sprite (43 actions)

When sprite is provided (or mode is `sprite`), action ids in
`contract.json` → `sprite.actionIds` must exist (or be declared missing).

## Voice

Clip ids are **stable name-agnostic ids** (see [`voice-ids.json`](../../packages/character-contract/voice-ids.json)).
Manifest entries use `id` + `i18nKey`; file name = `{id}.mp3`.
Legacy i18n-key aliases resolve for **one release** (`resolveVoiceClipId()` / `contract.voice.legacyKeyAlias`).

Required locale for official pack: `zh` (see `voice.requiredClipIds`; `validatePack(…, { requireCompleteVoice: true })`).

## Onboarding

Four files under pack `onboarding/`:

- `welcome.webp`
- `profile.webp`
- `provider.webp`
- `privacy.webp`

## Hitboxes

Ids: `head` / `face` / `body` / `hand` / `hem` (lower garment; formerly `skirt`).
Declared in `manifest.layout.hitboxes` (ratios of the character box) + optional `layout.bubbleAnchor`.
Without hitboxes the renderer classifies touches with its geometry heuristic (the official
`characters/nomi` pack declares none).
Legacy `layout/hitboxes.json` is still read and merged; packs that still ship `skirt` are
normalized to `hem` on load (`migrateHitboxIds()`).

## Brand lock

Official CI locks the sprite layers of `characters/nomi/sprite` via `brand-lock.json`.
Forks / white-label builds may set `CHARACTER_PACK_SKIP_BRAND_LOCK=1`.
The brand-lock script paths are parameterized (see `scripts/brand/update-brand-lock.mjs`).

## Loading

Build time: the renderer / ai-chat Vite builds read the selected pack (`CHARACTER_PACK`, default
`characters/nomi`) and emit it as `dist/character/…` (`scripts/character/vite-plugin.mjs`).
Nothing in the source tree is overwritten.

Run time (`CharacterPackService`): `userData/character-pack` → `resources/character-pack` → the
built-in pack (`resources/renderer/character` when packaged; the repository pack in development).
Every candidate goes through `validatePack`; invalid packs are skipped (logged). Overlays are
validated with `lenient: true`: the non-structural checks in `NON_STRUCTURAL_ISSUES` (rive file
size, missing fallback assets, voice manifests) only warn, structural errors still reject the pack.
Overlay assets are served via `character-pack://pack/…`; the views ask `character-pack:get-active`,
whose snapshot also carries the pack's `locales` lines. See [`REPLACING.md`](./REPLACING.md).

## Out of pack

`appId`, product name, update channel, UI theme tokens, UI copy (global i18n catalog),
character store / multi-character switch UI / pack store.
(Custom protocol `character-pack://` is in-pack for Scheme B assets only.)

## Attribution

Ship `CREDITS.md` / `LICENSE*` inside the pack; they travel with it into the build output.
In-repository packs are covered by `assets-licenses.json` (`pnpm check:licenses`).
