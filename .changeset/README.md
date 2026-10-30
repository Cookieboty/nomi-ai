# Changesets

> 本目录由 [@changesets/cli](https://github.com/changesets/changesets) 管理。
> 发布流程见 [docs/RELEASE.md](../docs/RELEASE.md)。

## Fixed group

以下三个包**必须同版本号**（changesets 会强制一起 bump）：

- `@nomi-ai/ai-sdk`
- `@nomi-ai/ai-runtime`
- `@nomi-ai/ai-sdk-client`

见 [config.json](config.json) 的 `fixed` 数组。

## Ignored（不参与版本化）

以下包目前**不对外发布**，因此从版本流程中 ignore：

- `@nomi-ai/host-electron`（应用主进程，走 electron-builder 发布通道）
- `@nomi-ai/renderer`
- `@nomi-ai/ai-chat`
- `@nomi-ai/types`
- `@nomi-ai/bundle-ig-base`
- `@nomi-ai/bundle-ig-electron-caps`
- `@nomi-ai/bundle-ig-mascot`

## 日常流程

1. **在 PR 中新增 changeset**：

   ```bash
   pnpm changeset
   ```

   选择本次涉及的包 + 版本类型（`patch` / `minor` / `major`）+ 摘要。命令会生成 `.changeset/xxx-yyy-zzz.md` 文件，一并提交。

2. **CI 校验**：CI 会跑 `pnpm changeset:status`（即 `changeset status --since=origin/main`）和 `pnpm changelog:check`；改动了包却没有 changeset 时会失败，纯文档 / 测试改动可用 `pnpm changeset --empty`。

3. **发版**：在 `main` 上执行 `pnpm changeset:version`，把 changeset 汇总进根目录 `CHANGELOG.md` 并把 fixed-group 三个包 bump 到同版本。这些包都是 `private`，不发布到 npm；应用的发布流程见 [docs/RELEASE.md](../docs/RELEASE.md)。

## 版本策略

- AIClient 公开签名破坏 → **major**
- 新增 facade / 方法 → **minor**
- bugfix / 内部重构 → **patch**
