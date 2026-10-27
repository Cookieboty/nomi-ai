# 设计师交付检查表

换肤流程与命令详见 **[REPLACING.md](./REPLACING.md)**。

- [ ] `manifest.json`（`schema` / `id` / `displayName` / `version` / `assets.mode`）
- [ ] **rive 模式**：`rive/character.riv`，契约内动作齐（或在 capabilities 声明缺失）
- [ ] **sprite**（强烈建议）：分层 + `thumb.png` + `manifest.json`
- [ ] **static 模式**：`static/character.webp`（建议最长边 ≥ 1024、透明底）；不要求 riv / 43 动作
- [ ] 四张 onboarding：`welcome` / `profile` / `provider` / `privacy`（`.webp`）
- [ ] `voice/zh` 下必选 clip id 的 mp3 + `manifest.json`（可后期补）
- [ ] `copy/zh.json` + `copy/en.json`（显示名、自称、系统提示身份句）
- [ ] 可选：`persona/system-prompt.md`、`layout/hitboxes.json`（含 `hem` + 可选 `bubbleAnchor`）、`CREDITS.md` / `assets-licenses/`、品牌图标
- [ ] `pnpm character:check -- path/to/pack` 通过
