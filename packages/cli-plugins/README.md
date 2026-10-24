# @nomi-ai/cli-plugins

内置编程助手插件（docs/design/cli-plugin-architecture.md §5、§7）：Claude Code、Codex、Grok、Gemini、dsh。

每个 CLI 一个目录，按子路径分入口：

| 子路径           | 内容                                                          | 谁能 import |
| ---------------- | ------------------------------------------------------------- | ----------- |
| `<cli>/manifest` | 清单（纯数据）                                                | 任何地方    |
| `<cli>/main`     | 主进程实现：启动、权限、账号、历史扫描、进度 / 用量目录、终端 | 只有主进程  |
| `<cli>/gateway`  | 网关侧数据（客户端规格）                                      | 网关进程    |
| `<cli>/renderer` | 界面信息（名称、图标、能力位、档位）                          | 渲染进程    |

根入口 `@nomi-ai/cli-plugins` 只有纯数据（全部清单、界面信息、`BUILTIN_CLI_IDS` / `CliId`）；
`@nomi-ai/cli-plugins/main` 是全部内置插件的主进程实现。ESLint 规则保证 `manifest` / `gateway` /
`renderer` 不依赖 `node:*` 与 `main`，`main` 不依赖 `renderer`。

`src/generated/ids.ts` 由 `pnpm -F @nomi-ai/cli-plugins gen:ids` 按目录生成（`typecheck` 会检查是否最新）。
