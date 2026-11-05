# AGENTS.md

给编程助手的仓库指南。用户文档在 [docs/README.md](docs/README.md)，架构在 [docs/development/architecture.md](docs/development/architecture.md)。

## 仓库结构

pnpm 9 + Turborepo monorepo。桌面应用只有 Go 版（`apps/desktop-go`：Go 内核 + Wails v3 外壳，2.2.0 起 Electron 版已删除）；视图（React 19 + Vite）在 `packages/` 里，构建产物内嵌进 Go 程序。Node ≥ 22.12（CI 用 24），Go 见 `apps/desktop-go/go.mod`。

| 路径                                                 | 内容                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop-go`                                    | 桌面应用：Go 内核（`internal/*`：AI 运行时与供应商、统一网关、编程助手插件与驱动、记忆、知识库、日程、语音等）+ Wails 壳，见 `apps/desktop-go/README.md`         |
| `apps/desktop-go/internal/gateway`                   | 统一网关：四种协议的请求 IR 与流式互转，见 `docs/development/gateway.md`                                                                                         |
| `apps/desktop-go/internal/contract`                  | 契约服务端（回环 WebSocket + 一次性 token），处理函数在 `internal/core/<域>handlers`                                                                             |
| `apps/desktop-go/assets`、`character-pack-resources` | 应用图标、托盘图标、背景等只读资源（打包进 resources）                                                                                                           |
| `packages/renderer`                                  | 桌面角色窗口：透明窗口、气泡、工具栏，`src/avatar` 把契约事件接到 avatar-runtime                                                                                 |
| `packages/avatar-runtime`                            | 角色引擎（纯浏览器，不依赖契约 / ui）：渲染后端、表情动作、命中区与互动，角色包见 `docs/character-pack/`                                                         |
| `packages/ai-chat`                                   | 对话窗口：对话、设置、引导、功能面板                                                                                                                             |
| `packages/ai-sdk-client`                             | 视图侧 AI 客户端（基于 `@nomi-ai/contract/app`）与窗口共享的契约传输（`installGoHostTransport`）                                                                 |
| `packages/contract`                                  | 视图与内核之间的 API 契约（自研 `defineContract`、类型化 client、WebSocket 传输），Go 侧经 `scripts/go-contract/gen.mjs` 生成，见 `docs/development/contract.md` |
| `packages/character-contract`                        | 角色包契约：manifest / persona / mapping 的 schema、校验与迁移，见 `docs/character-pack/CONTRACT.md`                                                             |
| `packages/cli-catalog`                               | 内置编程助手的清单与界面信息（纯数据，视图用）；`BuiltinCliId` 由 `gen:ids` 生成                                                                                 |
| `packages/ui`                                        | 设计令牌、主题、组件                                                                                                                                             |
| `packages/i18n`、`packages/voice`、`packages/types`  | 界面文案与翻译（Go 内核内嵌一份 `internal/core/i18n/locales` 副本）、语音、共享类型                                                                              |
| `packages/repo-paths`                                | 测试与脚本里拼仓库内路径（`repoPath('characters/nomi')`），不写跨出所在包的 `../`（`scripts/__tests__/repo-paths.test.ts` 会拦）；Go 测试用 `repotest.RepoPath`  |
| `scripts/`                                           | doctor、许可与 i18n 检查、角色包、mock CLI（`scripts/mock-cli`）、release 脚本                                                                                   |

## 命令

```bash
pnpm install
pnpm dev                 # 开发：Vite 开发服务器（renderer 6127、chat 6128，见 dev-ports.json）+ Go 程序，视图热更新，改 Go 代码自动重编译重启
pnpm build               # 构建视图与共享包
pnpm typecheck && pnpm lint   # lint 覆盖全部包
pnpm format:check
pnpm test                # 视图与共享包的单元测试（Vitest）
cd apps/desktop-go && go vet ./... && go test ./...   # Go 内核测试（macOS 加 -tags private_mac_apis，Linux 加 -tags gtk3）
node scripts/go-contract/gen.mjs --check   # 改了 packages/contract 后检查 Go 侧生成的契约（先 pnpm --filter @nomi-ai/contract build）
pnpm package             # 本机打安装包（apps/desktop-go/packaging/package.sh <平台>）
pnpm check:i18n          # 所有中文文案都有英文翻译（Go 源码里用到的 key 也算）
pnpm check:character-leak  # 官方角色名（诺米 / 角色语境的 Nomi）只在 characters/nomi 与 brand 里
pnpm check:licenses      # 依赖与素材只允许开源许可
pnpm changeset           # 用户可见的改动加 changeset；pnpm changelog:check
```

## 约定

- **界面文案**：视图里用 `t()` / `tr()` 与 `packages/i18n` 的稳定 key，中英文都写进 `packages/i18n/src/locales/{zh,en}`；Go 内核用 `internal/core/i18n` 的 `T()`，词典是 `packages/i18n` 的副本（改完复制到 `apps/desktop-go/internal/core/i18n/locales`，`dict_test.go` 守住一致）。例外：角色文案（台词、提示语、人设、语音字幕）跟着角色包走，写在角色包的 `locales/` 里，不进全局词典，见 [角色包契约](docs/character-pack/CONTRACT.md)。产品名用 `@nomi-ai/types` 的 `brand.appName`；指桌面角色的文案用当前角色名（人设 `displayName`），不写死「诺米」/「显示 Nomi」（`pnpm check:character-leak` 会拦）。
- **许可**：只引入开源许可（MIT / Apache-2.0 / BSD / ISC / CC0 / CC-BY 等）的依赖与素材，新素材登记到 `assets-licenses.json` / `CREDITS.md`。
- **日志**：视图里不用 `console.log`，用 `@nomi-ai/ui` 的 `createLogger`；Go 内核用 `internal/core/services` 的 logger。
- **安全**：视图经页面地址片段里的回环 WebSocket + 一次性 token 连 Go 内核（`installGoHostTransport` / `resolveHostTransport`），传输只在每个视图包的 `services/api.ts` 里选；视图对内核的调用都经 `@nomi-ai/contract`（过程在 `contract/src/app/<域>.ts`，Go 处理函数在 `internal/core/<域>handlers`），由契约判定 `surfaces` / `dangerous` / 事件的 `eventSurfaces`；外部请求走网关的网络守卫，私有文件、命令参数转义、API Key 加密存储都在 Go 内核里，不在视图里做。视图带来的目录（标签 cwd、Nomi 对话工作区 `extra.cwd`）内核要再校验（拒绝过宽的根与黑名单目录），不认就按没有处理。
- **界面**：CSS Modules + `var(--cd-*)` 令牌；面板懒加载；无障碍（aria-label、`Esc` 关闭、焦点管理、减少动态效果）。
- **弹窗**：不用系统弹窗（`window.confirm` / `alert` / `prompt`，eslint 会拦）；确认与输入用 `packages/ai-chat/src/components/ConfirmDialog` 的 `confirmDialog` / `promptDialog`，macOS / Windows 样式一致、文案跟界面语言。
- **样式一致性**：同一行的控件用同一个高度令牌（`--cd-control-h-*`：2xs 20 / xs 24 / sm 28 / ms 32 / md 36 / lg 40；对话区右上角 sm，输入栏工具行与对话头部 ms），同一行同一种形状与字号；尺寸 / 外观通过组件的 `size` / `variant` 改（如 `Select variant="ghost" | "chip"`），不在外部用 `:global(.cd-*)` 覆盖共享组件；hover 用 `--cd-color-hover`，键盘焦点用 `2px solid var(--cd-color-accent-strong)` 描边；字号、颜色、圆角、间距只用令牌（`pnpm check:frontend` 会拦下未定义的 `--cd-*`）。
- **提交**：Conventional Commits（commitlint，标题与正文每行 ≤ 100 字符）；pre-commit 跑 lint-staged。
- **Git**：不 force-push、不改写已推送的历史；不打 release tag，不自行合并 PR。
- **发布**：见 [docs/RELEASE.md](docs/RELEASE.md)。

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
