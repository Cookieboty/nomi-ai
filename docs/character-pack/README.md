# Character pack（单角色整包换肤）

产品永远只内置 **一套** 完整角色。换肤 = 构建前用素材包覆盖约定路径，再 `pnpm build`。

> **第三方 / fork 请先读 → [REPLACING.md](./REPLACING.md)**（复制示范包、校验、apply、恢复官方、brand-lock SKIP）。

## 快速开始

```bash
# 校验示范包（官方 Nomi）
pnpm character:check

# 从当前仓库资源导出 / 刷新 examples/nomi.pack
pnpm character:init

# 未设置 CHARACTER_PACK：幂等确保 character.generated.json 为官方 nomi（不改素材）
pnpm character:apply

# 应用自定义包后构建
CHARACTER_PACK=/path/to/my-character.pack pnpm character:apply && pnpm build
```

静态立绘包（无需 Rive / 43 动作）：

```bash
pnpm character:check -- examples/static-demo.pack
CHARACTER_PACK=examples/static-demo.pack pnpm character:apply && pnpm build
```

试完 static 示范后请按 [REPLACING.md § 恢复官方树](./REPLACING.md#4-恢复官方树本地试完换肤后) 还原素材；无 `CHARACTER_PACK` 的 `apply` **不会**自动还原图片。

## 设计假设（P0）

1. **官方 Nomi 优先**：无 `CHARACTER_PACK` 时行为与今日一致。
2. **Scheme A（构建期）**：`CHARACTER_PACK=… pnpm character:apply && pnpm build`。
   **Scheme B（运行时）**：把完整包放到 `userData/character-pack` 或随安装包 `resources/character-pack`；校验失败回退内置。
3. **v1 原地覆盖**现有路径（不改名为 `default/`）：
   - `packages/renderer/public/assets/models/rive/nomi-complete.riv`
   - `packages/renderer/public/assets/models/sprite/nomi/`
   - `packages/renderer/public/voice/nomi/`
   - `packages/ai-chat/src/components/Onboarding/art/`
   - static 模式另写：`packages/renderer/public/assets/models/static/character.webp`
4. 单角色；无商店 / 切换 UI；UI 主题与 `appId` 不进包。
5. 区域 id 为 `hem`（不再用 `skirt`）；voice clip 使用稳定 id（见 [`voice-ids.json`](../../packages/character-contract/voice-ids.json)），旧 key 别名保留一版。
6. Rive artboard / stateMachine（`Nomi-full` / `NomiFull`）写入契约，manifest 可覆盖。
7. 官方 CI 仍锁 nomi；fork 可用 `CHARACTER_PACK_SKIP_BRAND_LOCK=1`。
8. `static` 模式为一等公民。

## 文档

- **[REPLACING.md](./REPLACING.md) — 第三方换肤 / 替换指南（从这里开始）**
- [CONTRACT.md](./CONTRACT.md) — 契约说明
- [contract.json](../../packages/character-contract/contract.json) / [voice-ids.json](../../packages/character-contract/voice-ids.json) — 机器可读契约（`@nomi-ai/character-contract`，含 schema、`validatePack` 与迁移函数）
- [designer-checklist.md](./designer-checklist.md) — 设计师检查表
- 示范包：`examples/nomi.pack`、`examples/static-demo.pack`
