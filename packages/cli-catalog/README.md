# @nomi-ai/cli-catalog

内置编程助手（Claude Code、Codex、Grok、Gemini、dsh、Kimi Code、MiniMax Code）的清单与界面信息，纯数据与纯函数，
视图会 import（docs/development/coding-agents.md）。

| 内容                                                                                                    | 位置                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 清单类型与校验（`CliManifest`、`validateManifest`、`effectiveCapabilities`、`HarnessPermissionMode`）   | `src/manifest.ts`（子路径 `@nomi-ai/cli-catalog/manifest`）                                                |
| 各 CLI 的清单与档位映射                                                                                 | `src/<cli>/manifest.ts`（子路径 `@nomi-ai/cli-catalog/<cli>/manifest`）                                    |
| 界面信息（名称、图标、能力位、档位）                                                                    | `src/<cli>/renderer.ts`、`BUILTIN_RENDERER`                                                                |
| 权限档位、终端命令转义                                                                                  | `src/shared/permissions.ts`、`src/shared/terminal.ts`                                                      |
| 内置 id                                                                                                 | `src/generated/ids.ts`，由 `pnpm -F @nomi-ai/cli-catalog gen:ids` 按目录生成（`typecheck` 会检查是否最新） |
| 界面与名单的顺序、按能力位筛选（`BUILTIN_CLI_ORDER`、`cliCapability`；其它包不写死 CLI 名单，测试会拦） | `src/index.ts`                                                                                             |

清单只写在这里：Go 内核读由它生成的 `apps/desktop-go/internal/cliplugins/catalog/catalog.json`（`pnpm -F @nomi-ai/cli-catalog gen:go`，
测试会查它是否最新）。内核实现（启动、权限、账号、历史等）在 `apps/desktop-go/internal/cliplugins`。ESLint 规则保证本包不依赖 `node:*`、electron 与其它包。
