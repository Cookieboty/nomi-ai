# 设计师交付检查表

换肤流程与命令详见 **[REPLACING.md](./REPLACING.md)**。

- [ ] `manifest.json`（`schema` / `id` / `contractVersion` / `version` / `assets.mode`，建议带 `credits`）
- [ ] **rive 模式**：`rive/character.riv`，契约内动作齐（或在 capabilities 声明缺失）
- [ ] **sprite**（强烈建议）：分层 + `thumb.png` + `manifest.json`
- [ ] **static 模式**：`static/character.webp`（建议最长边 ≥ 1024、透明底）；不要求 riv / 43 动作
- [ ] 四张 onboarding：`welcome` / `profile` / `provider` / `privacy`（`.webp`）
- [ ] `voice/zh` 下必选 clip id 的 mp3 + `manifest.json`（可后期补）
- [ ] `persona.json`（显示名、系统提示身份句、问候）
- [ ] `locales/zh.json` + `locales/en.json`（英文人设、唤醒词、提示语 `lines`，两种语言 key 一致）
- [ ] 可选：`mapping.json`、`manifest.layout`（窗口、命中区含 `hem`、`bubbleAnchor`）、`CREDITS.md` / `LICENSE`
- [ ] `pnpm character:check -- path/to/pack` 通过
