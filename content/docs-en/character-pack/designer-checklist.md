# Designer Delivery Checklist

See **[REPLACING.md](./REPLACING.md)** for the skinning workflow and commands.

- [ ] `manifest.json` (`schema` / `id` / `contractVersion` / `version` / `assets.mode`; `credits` recommended)
- [ ] **rive mode**: `rive/character.riv` with all contract motions included (or missing ones declared in `capabilities`)
- [ ] **sprite** (strongly recommended): layered assets + `thumb.png` + `manifest.json`
- [ ] **static mode**: `static/character.webp` (recommended longest edge ≥ 1024 px, transparent background); does not require `.riv` or the 43 actions
- [ ] Four onboarding illustrations: `welcome` / `profile` / `provider` / `privacy` (`.webp`)
- [ ] Required clip id MP3s + `manifest.json` under `voice/zh` (can be added later)
- [ ] `persona.json` (display name, system prompt identity line, greetings)
- [ ] `locales/zh.json` + `locales/en.json` (English persona, wake phrase, tip `lines`; keys must match across both languages)
- [ ] Optional: `mapping.json`, `manifest.layout` (window size, hitboxes including `hem`, `bubbleAnchor`), `CREDITS.md` / `LICENSE`
- [ ] `pnpm character:check -- path/to/pack` passes
