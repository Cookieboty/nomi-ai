# @nomi-ai/cli-plugins

内置编程助手插件（docs/design/cli-plugin-architecture.md §5、§7）：Claude Code、Codex、Grok、Gemini、dsh。

每个 CLI 一个目录，按子路径分入口：

| 子路径          | 内容                                                          | 谁能 import |
| --------------- | ------------------------------------------------------------- | ----------- |
| `<cli>/main`    | 主进程实现：启动、权限、账号、历史扫描、进度 / 用量目录、终端 | 只有主进程  |
| `<cli>/gateway` | 网关侧数据（客户端规格）                                      | 网关进程    |

清单与界面信息（名称、图标、能力位、档位）、`BUILTIN_CLI_IDS` / `CliId` 是两个版本共用的视图也要用的纯数据，
在 [`@nomi-ai/cli-catalog`](../../../../packages/cli-catalog/README.md)；根入口 `@nomi-ai/cli-plugins` 原样转出它，
`@nomi-ai/cli-plugins/main` 是全部内置插件的主进程实现。ESLint 规则保证 `gateway` 不依赖 `node:*` 与 `main`，
`main` 不依赖界面信息。
