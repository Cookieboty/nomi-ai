# Character pack（单角色整包换肤）

产品一次只带 **一套** 完整角色。官方角色 Nomi 也只是一个普通角色包：[`characters/nomi`](../../characters/nomi)。
换肤 = 构建时选另一个包（`CHARACTER_PACK=<dir>`），或运行时放一个覆盖包；仓库里的文件不会被改写。

> **第三方 / fork 请先读 → [REPLACING.md](./REPLACING.md)**（新建包、校验、构建、运行时覆盖、brand-lock）。

## 快速开始

```bash
# 校验官方包 characters/nomi（官方包要求语音完整）
pnpm character:check

# 校验任意包
pnpm character:check -- characters/test-dummy

# 从模板新建一个包（static 模式、占位图）
pnpm character:init -- ../my-character.pack my-character

# 构建前预检：校验将要打进安装包的包（只读，不改任何文件）
CHARACTER_PACK=../my-character.pack pnpm character:apply

# 用这个包构建（renderer / ai-chat 直接读包）
CHARACTER_PACK=../my-character.pack pnpm build
```

## 设计要点

1. **默认包 = `characters/nomi`**：没有 `CHARACTER_PACK` 时构建官方 Nomi。官方包与第三方包走同一条加载与校验路径。
2. **构建期**：`scripts/character/vite-plugin.mjs` 读所选包——开发态在 `/character/…` 直接提供包内文件，构建时输出到
   `renderer/dist/character/`（整包）与 `ai-chat/dist/character/onboarding/`（引导插画）；同时生成
   `assets/models/model-list.json` 和 `virtual:character-pack`（规范化后的包数据）。不再原地覆盖任何路径，也没有
   `character.generated.json`。
3. **运行时**：`CharacterPackService` 按 `userData/character-pack` → `resources/character-pack` → 内置包解析，第一个
   通过 `validatePack`（`@nomi-ai/character-contract`）的包生效。内置包在安装包里是 `resources/renderer/character`，
   开发态是仓库里的 `CHARACTER_PACK` 或 `characters/nomi`。
4. **人设与角色文案跟着包走**：`persona.json` + `locales/{zh,en}.json`。系统提示的身份段、问候、看板娘的提示语都从
   当前包读；`pnpm check:i18n` 检查每个包的 zh / en 一致。
5. 单角色；无商店 / 切换 UI；UI 主题、`appId`、产品名不进包。
6. 区域 id 为 `hem`（不再用 `skirt`）；voice clip 使用稳定 id（见
   [`voice-ids.json`](../../packages/character-contract/voice-ids.json)），旧 key 别名保留一版。
7. 官方 CI 锁定 `characters/nomi/sprite` 的品牌图层；fork 可用 `CHARACTER_PACK_SKIP_BRAND_LOCK=1`。
8. `static` 模式为一等公民；替身包 [`characters/test-dummy`](../../characters/test-dummy) 用它验证「换了角色就不再出现 Nomi」。

## 文档

- **[REPLACING.md](./REPLACING.md) — 第三方换肤 / 替换指南（从这里开始）**
- [CONTRACT.md](./CONTRACT.md) — 契约说明
- [contract.json](../../packages/character-contract/contract.json) / [voice-ids.json](../../packages/character-contract/voice-ids.json) — 机器可读契约（`@nomi-ai/character-contract`，含 schema、`validatePack` 与迁移函数）
- [designer-checklist.md](./designer-checklist.md) — 设计师检查表
- 包：`characters/nomi`（官方）、`characters/test-dummy`（替身）、`examples/static-demo.pack`（旧格式示范）
