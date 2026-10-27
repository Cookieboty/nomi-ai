# Credits

## Nomi image theme preset

- **Bundled background** (`packages/electron/assets/backgrounds/nomi-preset.jpg`) — supplied by the user and confirmed as free material on 2026-10-26. The original source, author and exact licence were not supplied; recorded as `LicenseRef-UserProvided-Free`, not MIT or CC0. Inclusion does not resolve the existing release licence gate.

## Nomi·诺米 brand & mascot

- **Brand board, mascot artwork (2D pseudo-3D layered rig `sprite/nomi`, body cut from the owner's half-body illustration, head from the owner's front-facing HD head image), logo concept** — owner-provided, AI-generated, licensed by project owner (Cookieboty) for use in this repository under the MIT licence.
- **Hand / forearm pieces** (`sprite/nomi/layers/hands/`) — AI-generated, non-brand art (a neutral forearm cuff and hand in nine shapes: wave, fist, thumbs-up, point, rest, peace, plus prayer / OK / hand-on-chest), cut out and colour-matched to the master by Nomi-ai contributors; licensed by the project owner under the MIT licence. They are the only AI-generated pixels added to the rig after the brand artwork was fixed; no brand part (hair, hairclips, bow, earring, choker, jacket, logo, tag) is generated or redrawn — see [docs/BRAND.md](docs/BRAND.md#9-品牌锁).
- **Onboarding illustrations** (`packages/ai-chat/src/components/Onboarding/art/*.webp`: welcome, appearance, profile, provider) — AI-generated scene art requested by the project owner (Cookieboty) for the first-run guide and licensed by the project owner under the MIT licence. They are decorative only and are **not** brand-lock master art; the rig and brand parts are unchanged — see [docs/BRAND.md](docs/BRAND.md#9-品牌锁).
- **Vector logo / app icons / tray icons** (`docs/brand/*.svg`, `packages/electron/assets/`) — recreated as vectors from the brand board by Nomi-ai contributors; same terms.

## Code references

- **[magpie](https://github.com/yetone/magpie)** by yetone — MIT licence (© 2026 yetone).
  - Unified gateway (`packages/gateway/`): design reference for reasoning-effort fitting (`fitLevel`), passing sealed reasoning back unchanged (`SealedBy`), tool-call ids and pairing, and text tool calls; the fixed effort↔budget table in `packages/gateway/src/intent.ts` (4096 / 10000 / 24000 / 32000 and the 4096 / 12000 / 24000 thresholds) uses magpie's values (`internal/gateway/ir.go` `budgetOf` / `effortOfBudget`).
  - Privacy mode (`packages/gateway/src/privacy/`): design reference for secret masking from `internal/redact`, `internal/masking`, `internal/gwmw` and `LESSONS.md` — `{{KIND_xxxxxxxx}}` placeholders keyed by HMAC-SHA256, restoring them in streamed responses, masking already-seen values, skip rules, and refusing to send when masking fails, plus shape-preserving fake keys. The code is an independent TypeScript implementation, **except** several built-in secret-detection regexes in `packages/gateway/src/privacy/rules.ts` (private key block, `sk-…`, relay `xx_sk_…`, GitHub / GitLab tokens, `AIza…`, `AKIA/ASIA…`, Slack `xox…`, JWT, `scheme://user:pass@`), which are ported from magpie `internal/redact/redact.go`. magpie's copyright notice and MIT licence text are reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md#magpie).

Third-party assets and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and enforced by `assets-licenses.json` (`node scripts/check-licenses.mjs`).
