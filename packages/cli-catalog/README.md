# @nomi-ai/cli-catalog

内置编程助手（Claude Code、Codex、Grok、Gemini、dsh）的清单与界面信息，纯数据与纯函数，
视图会 import（docs/development/coding-agents.md）。

| 内容                                                                                                  | 位置                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 清单类型与校验（`CliManifest`、`validateManifest`、`effectiveCapabilities`、`HarnessPermissionMode`） | `src/manifest.ts`（子路径 `@nomi-ai/cli-catalog/manifest`）                                                |
| 各 CLI 的清单与档位映射                                                                               | `src/<cli>/manifest.ts`（子路径 `@nomi-ai/cli-catalog/<cli>/manifest`）                                    |
| 界面信息（名称、图标、能力位、档位）                                                                  | `src/<cli>/renderer.ts`、`BUILTIN_RENDERER`                                                                |
| 权限档位、终端命令转义                                                                                | `src/shared/permissions.ts`、`src/shared/terminal.ts`                                                      |
| 内置 id                                                                                               | `src/generated/ids.ts`，由 `pnpm -F @nomi-ai/cli-catalog gen:ids` 按目录生成（`typecheck` 会检查是否最新） |

内核实现（启动、权限、账号、历史等）在 `apps/desktop-go/internal/cliplugins`。ESLint 规则保证本包不依赖 `node:*`、electron 与其它包。
