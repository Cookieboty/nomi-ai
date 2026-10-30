# 从其他工具导入 MCP 服务器与技能（#58）

设置 → 扩展 → 「从其他工具导入」。主进程扫描、转换、写入；渲染进程只拿到脱敏预览和每项的 key，
永远拿不到文件路径或密钥原文。代码：`apps/desktop-electron/internal/core/src/extensions/migrate.ts`（只读发现 + 转换）、
`ExtensionsService.migrateScan / migrateImport`（IPC `ai:ext:migrate-scan` / `ai:ext:migrate-import`，guardedHandle）、
`packages/ai-chat/src/components/ExtensionsPanel/MigrateDialog.tsx`。

## 来源（依据官方文档，2026-10）

| 工具        | MCP                                                                                                                                                | 技能                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Claude Code | `~/.claude.json` 顶层 `mcpServers`（user）、`projects[<路径>].mcpServers`（local）；`$CLAUDE_CONFIG_DIR/.claude.json`；项目 `.mcp.json`（project） | `~/.claude/skills/*/SKILL.md`、`$CLAUDE_CONFIG_DIR/skills`、项目 `.claude/skills` |
| Codex       | `$CODEX_HOME/config.toml`（默认 `~/.codex`）与项目 `.codex/config.toml` 的 `[mcp_servers.<名>]`，用 smol-toml 解析                                 | `~/.agents/skills`（官方）、`$CODEX_HOME/skills`（旧位置）、项目 `.agents/skills` |

项目文件夹只能由主进程的系统对话框选择，不接受渲染进程传入路径。

## 转换

- Claude `type`：`stdio` / `http` / `streamable-http` / `sse` 支持；`ws`、`sdk` 标为不支持；缺 `type` 有 `url` 时按 HTTP 并提示。
- Codex：有 `url` 为远程（路径以 `/sse` 结尾按 SSE），否则 stdio；`http_headers` → 请求头；`enabled = false` 提示「原配置中已停用」。
- 不支持、只提示的字段：`${VAR}` 展开、`headersHelper` / `http_headers_helper`、OAuth、`bearer_token_env_var`、
  `env_http_headers`、`env_vars`、`cwd`、`allowed-tools`。不认识的字段宽松忽略。
- 导入后的服务器 `enabled=false`、`trust=ask`，用户检查后再连接。

## 安全

- **读配置（#16）**：只读上面固定的文件名；符号链接解析后的真实文件名必须不变、不能落在凭据目录（DENY_DIR，
  如 `~/.ssh`、`~/.aws`）、必须仍在用户目录 / 项目目录内；按真实路径打开后校验是普通文件、大小上限、inode 不变。
  `~/.claude.json` 里的账号、历史等内容解析后立即丢弃，只保留 `mcpServers`。
- **密钥（#35）**：env、请求头里的值，以及看起来像令牌的值（`isSecretValue`）用 safeStorage 加密；
  safeStorage 不可用时该项导入失败，不写明文。启动参数按原样保存（与手动添加一致），看起来含令牌时提示改用环境变量。
- **预览（#18）**：env / 请求头打码，args / URL 用导出脱敏规则处理。
- **技能：复制而不是引用。** 引用意味着 Nomi 之后读到的内容会随其他工具或仓库变化，还要长期跟随外部符号链接；
  复制成快照后，只需在导入那一刻做一次校验：
  - 不跟随技能目录内的符号链接（O_NOFOLLOW 打开），跳过隐藏文件和凭据类文件名（DENY），最多 200 个文件、深度 4、总计 ≤ 5 MB；
  - 项目里的技能目录如果链接到项目和用户技能目录之外，直接拒绝；用户目录里的技能允许链接到别处（用户自己建的共享技能），但不能落在凭据目录；
  - 扫描后源目录被改动（真实路径变化、文件变成链接）则拒绝，请用户重新扫描；
  - 先写到 `skills/.import-<随机>` 临时目录，`parseSkillMd` 校验通过后再改名就位；覆盖时旧目录先挪到备份名，失败会还原。
  - 名称不符合 Nomi 规则、改名导入或头部是多行 YAML 时，用 Nomi 的格式重写 SKILL.md 头部，正文不变。附带脚本只作为参考文件复制，Nomi 不执行。

## 冲突

同名（名称不区分大小写或 id 相同）时默认不勾选；勾选后逐项选择：

- 跳过；
- 重命名：MCP 为 `名称 (Claude Code)` / `名称 (Codex)`，技能为 `名称-claude` / `名称-codex`，仍冲突时加序号；
- 覆盖：MCP 保留原 id（先断开连接）；技能整个目录替换。

## 待真机验证

真实的 `~/.claude.json`、`~/.codex/config.toml` 与技能目录（尤其 Windows 路径、CLAUDE_CONFIG_DIR / CODEX_HOME 自定义位置）。
