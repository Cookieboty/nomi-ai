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

Clip ids are the existing i18n keys (e.g. `ui.cli-monitor.hi-i-m-nomi`).
**De-nomi-semantic rename is out of P0** — aliases may be added later.
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

Ids: `head` / `face` / `body` / `hand` / `skirt`.
`hem` is an accepted **alias** of `skirt` in P0 (rename deferred).

Optional `layout/hitboxes.json` documents region ratios for designers (`hem` alias of `skirt`).
P0 runtime still uses built-in proportions; wiring pack hitboxes into hit-testing is deferred.

## Brand lock

Official CI still locks Nomi sprite layers via `brand-lock.json`.
Forks / white-label builds may set `CHARACTER_PACK_SKIP_BRAND_LOCK=1`.
The brand-lock script paths are parameterized (see `scripts/brand/update-brand-lock.mjs`).

## Out of pack

`appId`, protocol, update channel, UI theme tokens, character store / switch UI.
Scheme B (runtime `userData` pack) is **deferred**.
