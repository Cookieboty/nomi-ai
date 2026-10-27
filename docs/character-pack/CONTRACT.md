# Character Pack Contract (v1)

Freeze list for a single build-time character pack. Pack authors replace content;
clip / action / file **names** stay stable unless the contract bumps.

Official Nomi first: with no `CHARACTER_PACK`, the app behaves exactly as today.

Third-party skinning steps: [`REPLACING.md`](./REPLACING.md).

## Modes

| `manifest.assets.mode` | Required assets                  | Notes                                                 |
| ---------------------- | -------------------------------- | ----------------------------------------------------- |
| `rive` (default)       | `rive/character.riv`             | Primary path; sprite strongly recommended as fallback |
| `sprite`               | `sprite/` layered rig            | May be primary or fallback                            |
| `static`               | `static/character.webp` (or png) | No `.riv`, no 43 actions required                     |

Machine-readable copy: [`contract.json`](./contract.json).

## Rive

| Field         | Default (Nomi)      | Override                                   |
| ------------- | ------------------- | ------------------------------------------ |
| Artboard      | `Nomi-full`         | `manifest.rive.artboard`                   |
| State machine | `NomiFull`          | `manifest.rive.stateMachine`               |
| Ship filename | `nomi-complete.riv` | v1 **overwrites in place** (do not rename) |

Native motion clip names: see `contract.json` → `rive.nativeMotions`.
Missing clips may be listed under `manifest.capabilities.riveMotions` omissions;
runtime skips unknown ids.

## Sprite (43 actions)

When sprite is provided (or mode is `sprite`), action ids in
`contract.json` → `sprite.actionIds` must exist (or be declared missing).
v1 overwrite target: `packages/renderer/public/assets/models/sprite/nomi/`.

## Voice

Clip ids are **stable name-agnostic ids** (see [`voice-ids.json`](./voice-ids.json)).
Manifest entries use `id` + `i18nKey`; file name = `{id}.mp3`.
Legacy i18n-key aliases resolve for **one release** (`legacyClipIds.json` / `contract.voice.legacyKeyAlias`).
v1 overwrite target: `packages/renderer/public/voice/nomi/`.

Required locale for official pack: `zh` (see `voice.requiredClipIds`).

## Onboarding

Four files under pack `onboarding/`:

- `welcome.webp`
- `profile.webp`
- `provider.webp`
- `privacy.webp`

v1 overwrite target: `packages/ai-chat/src/components/Onboarding/art/`.

## Hitboxes

Ids: `head` / `face` / `body` / `hand` / `hem` (lower garment; formerly `skirt`).
Optional `layout/hitboxes.json` — ratios of the character box + optional `bubbleAnchor`.
Runtime reads pack hitboxes (Scheme A embedded in generated config, Scheme B via overlay).
Legacy packs that still ship `skirt` are normalized to `hem` on load.

## Brand lock

Official CI still locks Nomi sprite layers via `brand-lock.json`.
Forks / white-label builds may set `CHARACTER_PACK_SKIP_BRAND_LOCK=1`.
The brand-lock script paths are parameterized (see `scripts/brand/update-brand-lock.mjs`).

## Scheme B (runtime overlay)

Resolve order: `userData/character-pack` → `resources/character-pack` → built-in.
Invalid packs are skipped (logged) and fall back to built-in.
Assets are served via `character-pack://pack/…`; renderer asks `character-pack:get-active`.
See [`REPLACING.md`](./REPLACING.md) § Scheme B.

## Out of pack

`appId`, update channel, UI theme tokens, character store / multi-character switch UI / pack store.
(Custom protocol `character-pack://` is in-pack for Scheme B assets only.)

## Attribution (optional)

If the pack ships `CREDITS.md` / `CREDITS.txt` / `LICENSE*` or `assets-licenses/`,
`character:apply` copies them to `docs/character-pack/applied-credits/`.
