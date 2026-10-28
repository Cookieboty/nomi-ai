# AGENTS.md

给编程助手的仓库指南。用户文档在 [docs/README.md](docs/README.md)，架构在 [docs/development/architecture.md](docs/development/architecture.md)。

## 仓库结构

pnpm 9 + Turborepo monorepo，Electron 桌面应用（React 19 + Vite）。Node ≥ 22.12（CI 用 24）。

| 路径                                | 内容                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`                     | 应用内核（纯 Node，不依赖 Electron）：编程助手、用量、网关服务、记忆、知识库、日程、扩展、语音等业务模块与契约处理函数；平台能力经宿主端口       |
| `packages/host-electron`            | 主进程宿主：`src/main.ts` → `core/Application.ts`（组合根），窗口、托盘、协议、preload、端口的 Electron 实现、契约传输                           |
| `packages/renderer`                 | 看板娘窗口（角色渲染在 `src/mascot`）                                                                                                            |
| `packages/ai-chat`                  | 对话窗口：对话、设置、引导、功能面板                                                                                                             |
| `packages/ai-runtime`               | AI 运行时：插件宿主、供应商路由（`src/providers`）、MCP 桥                                                                                       |
| `packages/gateway`                  | 统一网关内核（纯 Node）：四种协议的请求 IR 与流式互转，见 `docs/design/unified-gateway.md`                                                       |
| `packages/cli-sdk`                  | 编程助手插件契约与共享会话驱动（acp / stream-json / app-server / exec，纯 Node），见 `docs/design/cli-plugin-architecture.md` §5                 |
| `packages/contract`                 | 视图与内核之间的 API 契约（自研 `defineContract`、类型化 client、router 中间件、传输适配），见 `docs/design/core-host-decoupling.md` §4–§5       |
| `packages/host-ports`、`host-node`  | 宿主端口接口（路径、密钥、对话框、窗口等）/ 无界面宿主实现（测试与开发），见同上 §6                                                              |
| `packages/character-contract`       | 角色包契约：manifest / persona / mapping 的 schema、校验与迁移，见同上 §10                                                                       |
| `packages/cli-plugins`              | 内置编程助手插件（claude / codex / grok / gemini / dsh），按 `<cli>/{manifest,main,gateway,renderer}` 分子路径；`BuiltinCliId` 由 `gen:ids` 生成 |
| `packages/ai-sdk` / `ai-sdk-client` | 主进程 AI 门面 / 渲染进程客户端（基于 `@nomi-ai/contract/app`）与 preload 桥（`window.nomiTransport`、`window.nomiHost`）                        |
| `packages/bundle-ig-*`              | 插件包：`base`（不得 import electron）、`electron-caps`、`mascot`                                                                                |
| `packages/ui`                       | 设计令牌、主题、组件、i18n（`src/locales/en.json`）                                                                                              |
| `packages/voice`、`packages/types`  | 语音、共享类型                                                                                                                                   |
| `e2e/`、`e2e-headed/`               | 无界面 E2E（Vitest）/ 真实应用 E2E（Playwright），见 [testing.md](docs/development/testing.md)                                                   |
| `scripts/`                          | doctor、dev-smoke、许可与 i18n 检查、release 脚本                                                                                                |

## 命令

```bash
pnpm install
pnpm dev                 # 开发（renderer 6127、chat 6128，见 dev-ports.json）
pnpm build
pnpm typecheck && pnpm lint   # lint 覆盖全部包
pnpm format:check
pnpm test                # 单元测试：core / host-electron 用 Jest（tests/unit），其余包用 Vitest
pnpm test:e2e            # 无界面 E2E
xvfb-run -a pnpm test:e2e:headed   # 真实应用 E2E，必须在仓库根目录运行
pnpm check:i18n          # 所有中文文案都有英文翻译
pnpm check:licenses      # 依赖与素材只允许开源许可
pnpm changeset           # 用户可见的改动加 changeset；pnpm changelog:check
```

Linux 无显示器时 Electron 相关命令前加 `xvfb-run -a`。

## 约定

- **界面文案**：中文原文写在代码里作为 key，用 `t()` / `tr()`（主进程用 `packages/core/src/i18n`），英文翻译同步加到 `packages/ui/src/locales/en.json`；改中文 key 时同时改 en.json。例外：角色文案（台词、提示语、人设、语音字幕）跟着角色包走，写在角色包的 `locales/` 里，不进全局 en.json，见 [内核宿主分离 §10.2](docs/design/core-host-decoupling.md)。
- **许可**：只引入开源许可（MIT / Apache-2.0 / BSD / ISC / CC0 / CC-BY 等）的依赖与素材，新素材登记到 `assets-licenses.json` / `CREDITS.md`。
- **日志**：不用 `console.log`；主进程用 `LoggerService` / `createMainLogger`，渲染进程用 `@nomi-ai/ui` 的 `createLogger`。
- **安全**：preload 只暴露 `window.nomiTransport`（契约传输）与 `window.nomiHost`（拖入文件，路径在 preload 里解析）；视图对内核的调用都经 `@nomi-ai/contract`（过程在 `contract/src/app/<域>.ts`，处理函数在 `core/src/contract/<域>.ts`，用到窗口的在 `host-electron/src/host/contract/<域>.ts`），由契约判定 `surfaces` / `dangerous` / 事件的 `eventSurfaces`，不新增 IPC 通道（`host/` 之外禁止 `ipcMain`）；契约传输经 `host/ipcSenderGuard.ts` 判定调用者；外部请求走 `netGuard`，命令参数用 `shellEscape`，私有文件用 `utils/privateFile`（这三个在 `packages/core/src`）；API Key 存 `safeStorage`。开发态 userData 包名迁移见 `utils/legacyUserData.ts`。
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
