# 编程助手接入

Nomi 把 Claude Code、Codex、Gemini CLI、Grok、dsh 当作子进程驱动，在对话窗口里以「标签」呈现。用户的功能说明见
[features/coding-agents.md](../features/coding-agents.md)；本页讲实现。

```
视图（ai-chat 标签页）──契约 harness.* / cli.*──▶ 编排器（internal/core/cli/harness）
                                                   │  启动参数、环境、权限档位 ← 插件（internal/cliplugins/<cli>）
                                                   ▼
                                           会话驱动（internal/clisdk/drivers）──stdio──▶ CLI 子进程
                                                                                         │ 第三方来源时
                                                                                         ▼
                                                                          统一网关（nomi-tab- 令牌，见 gateway.md）
```

## 组成

| 位置                                           | 作用                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/cli-catalog`                         | 每个内置 CLI 的清单（id、能力位、会话传输、权限档位映射）与界面信息，纯数据；视图与内核都用                 |
| `apps/desktop-go/internal/clisdk`              | 插件契约（清单校验、能力接口、多选项权限回答）、外部 ACP 插件、子进程启动（`launch/`）与 JSON-RPC（`rpc/`） |
| `apps/desktop-go/internal/clisdk/drivers`      | 四种会话驱动：`acp`、`streamjson`、`appserver`、`exec`                                                      |
| `apps/desktop-go/internal/cliplugins/<cli>`    | 内置插件：启动注入、权限档位、官方账号目录、历史转录解析、模型目录、斜杠命令；共用部分在 `shared/`          |
| `apps/desktop-go/internal/core/cli/sandbox`    | 系统级沙箱（macOS Seatbelt）：按标签生成配置、违规日志监听与分类，见 security.md「编程助手」                |
| `apps/desktop-go/internal/core/cli/harness`    | 编排器：标签、持久化、来源（官方 / 第三方）、权限队列、插话（steer）、空闲回收、升级重启                    |
| `apps/desktop-go/internal/core/cli/accounts`   | 官方账号：识别终端里登录的账号、导入、登录、切换（各 CLI 自己的 HOME / 钥匙串）                             |
| `apps/desktop-go/internal/core/cli/delegate`   | Nomi 把任务交给编程助手（`delegate_to_cli`）：直接改 + 按文件裁决，别的分支做基线时用 worktree，复用会话    |
| `apps/desktop-go/internal/core/cli`（其余）    | CLI 探测与版本、安装 / 更新、历史会话、git 操作（变更面板）、斜杠命令发现、工作区文件                       |
| `apps/desktop-go/internal/core/codinghandlers` | 编程助手相关的契约过程                                                                                      |

标签的消息存在 `harness/tabs/<标签>.json`（最多 300 条，写盘有 200 ms 防抖）。内核内存里只留最近读过的 6 个标签
（`MaxCachedTabMessages`），多出来的在当前同步操作结束后回收；在跑 / 排队的、还有没写盘的、当前标签不回收，再读时从文件加载。

## 会话传输

| CLI         | 传输                     | 回退   |
| ----------- | ------------------------ | ------ |
| Claude Code | `stream-json`            | `exec` |
| Codex       | `app-server`（JSON-RPC） | `exec` |
| Gemini CLI  | `acp`                    | —      |
| Grok        | `acp`                    | `exec` |
| dsh         | `exec`                   | —      |
| Kimi Code   | `acp`                    | —      |
| MiniMax     | `acp`                    | —      |

传输写在 `packages/cli-catalog/src/<cli>/manifest.ts` 的 `transport` / `fallbackTransport`。外部 ACP 插件只有声明式清单
（`userData/cli-plugins/external/*.json`），不加载代码。

协议细节都在驱动里；每个 CLI 的差异（流式事件解析、历史转录、模型目录、斜杠布局）在它的插件里。编排器按清单的能力位判断，
不按 CLI 名字分支（视图侧由 eslint 规则 `nomi/no-cli-literal` 拦下，白名单在 `scripts/eslint/cli-literal-allowlist.mjs`）。

## 内置助手注册表

**数据只写一处**：每个内置 CLI 的声明式信息都在 `packages/cli-catalog/src/<id>/manifest.ts`——能力位、传输、可执行文件与
npm 包、权限档位 → 原生模式、显示名与完整名称（`fullName`）、配置文件路径（`configPath`），以及内核运行它要知道的事
（`host`：最低 Node 版本、自更新方式、官方厂商、ACP 启动参数、计划后续、有没有 `nomi-<id>` 命令）。界面与名单的顺序是
`BUILTIN_CLI_ORDER`。Go 内核读由它生成的 `internal/cliplugins/catalog/catalog.json`（`pnpm -F @nomi-ai/cli-catalog gen:go`；
`tests/go-catalog.test.ts` 检查是否最新），不再手写 Go 清单。

**Go 只登记代码**：`internal/cliplugins/<id>/` 写主进程实现（`CreateMain()`：官方 / 第三方启动、账号目录、斜杠命令等），
`builtin.entries` 登记它和会话记录解析。内核里要按 CLI 区分的东西都从 `internal/cliplugins/builtin` 取：

| 要什么                                        | 从哪取                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 有哪些内置 CLI                                | `builtin.IDs`（按 id 排序）、`builtin.Ordered`（界面与名单的顺序）                            |
| 插件能力（权限、账号、历史、斜杠命令、终端…） | `builtin.Impl(id)`（各插件的 `CreateMain()`，只建一次）                                       |
| 显示名                                        | `builtin.DisplayName`（「Gemini」）、`builtin.FullName`（「Gemini CLI」：看板、用量、灵动岛） |
| 清单能力位、传输、可执行文件、npm 包          | `builtin.Capability`、`builtin.UsesAcp`、`builtin.Binaries`、`builtin.NpmPackage`             |
| 清单 `host` 段                                | `builtin.MinNode`、`SelfUpdate`、`Vendor`、`AcpArgs`、`PlanFollowUp`、`NomiCommand`           |
| 按能力筛的名单                                | `builtin.Where(builtin.WithAccounts / WithHistory / WithQuota / WithThirdParty / All)`        |

视图侧用 `@nomi-ai/cli-catalog` 的 `BUILTIN_CLI_ORDER`、`cliCapability`、`cliName`、`cliFullName`、`cliConfigPath`、`byCli`。
ACP 助手的权限能力由清单推出（`shared.AcpPermissions`），不在 Go 里再写映射。两个守卫测试拦下写死的名单（同一行或分行写的
3 个及以上内置 id）：Go 侧 `internal/cliplugins/builtin/hardcoded_test.go`，视图侧
`packages/cli-catalog/tests/no-hardcoded-lists.test.ts`；确实只属于某几个 CLI 的实现（额度查询、用量日志解析、品牌图标、
网关客户端条目）登记在测试里的白名单并写明原因。`builtin_test.go` 检查代码条目与清单一一对应、清单的 `history` 与实现一致。

加一个内置助手（以 ACP 为例）：

1. `packages/cli-catalog/src/<id>/`：`manifest.ts` 与 `renderer.ts`；`BUILTIN_CLI_ORDER` 末尾加上它；跑 `gen:ids` 与 `gen:go`。
2. `apps/desktop-go/internal/cliplugins/<id>/`：`manifest.go`（两行：从 catalog 取）与 `CreateMain()`；在 `builtin.entries` 登记。
3. 品牌图标（`packages/ui/src/brand/endpointGlyphs.ts` 与灵动岛页面里的同一份）、中英文文案与文档。

之后名单、显示名、检测、安装与更新、看板认进程、委派、ACP 启动、设置页都自动带上它；额度查询、用量日志要用时再在各自的
地方补实现。

第三方模型：清单 `thirdParty: true`，插件实现 `Launch.ThirdParty`，返回私有主目录（`PrivateHome`：环境变量、不链的条目）
与要写的配置文件（`Files`）；`gwstore/agents.AgentLaunchFor` 对没有专门实现的 CLI 调它，建私有主目录、写文件（0600）。
网关里没有专门条目的用通用条目（`clients.GenericSpec`：宽松校验、不认识的模型名映射到主模型）。模型写在配置里，
换模型时重启进程并用 `session/load` 续接。终端里的 `nomi-<cli>` 命令要启动脚本支持（清单 `host.nomiCommand`）。

## 项目

项目（`internal/core/projects`，`userData/projects.json`，契约 `project.*` / `project.changed`）是有名字的一组文件夹：`primary` 是主文件夹，
`folders` 是其余文件夹。模型与 ACP 的 [Additional Directories](https://agentclientprotocol.com/rfds/additional-directories) 一致：
`cwd` 仍是主目录、相对路径的基准，其余文件夹只扩大读写范围；git、worktree、AGENTS.md 只看主文件夹。

- **会话只记 projectId**：Nomi 对话在会话元信息里，编程助手在标签对象里（`tabs.json`）。目录不存进会话，每次用时由
  `Store.Roots(id)` 实时取并按工作区根规则再查一遍：主文件夹不能用则整个项目不可用，其余文件夹不能用则跳过。
- **Nomi**：`desktop.ApplyConversationWorkspace` 按 `extra.projectId` 取 `desktop.Workspace`，把 `extra.cwd` 改写成主文件夹（视图带来的丢掉）；
  文件工具每次调用按 `ExecContext.ProjectID` 重新取（`PermissionBroker.WorkspaceOf`），守卫的作用域是全部文件夹（`Workspace.Scopes`）。
- **编程助手**：工作目录是主文件夹（委派的 worktree 标签例外），其余文件夹每次启动时由 `Orchestrator.extraDirs` 取：Claude Code `--add-dir`、
  Codex app-server 每轮 `sandboxPolicy.writableRoots`（exec 回退用 `-c sandbox_workspace_write.writable_roots`）、Gemini `--include-directories`、
  其余 ACP 助手声明 `sessionCapabilities.additionalDirectories` 时在 `session/new` / `session/load` 里带上；Nomi 的系统沙箱也把它们加进可写目录。
  项目改了（`Store.OnChange` → `Orchestrator.ProjectChanged`）：空闲标签断开常驻进程，下一轮按新的文件夹重启接着原会话；主文件夹换了的换工作目录、带上前文。
- **右栏**：视图把项目的全部文件夹（工作目录在前）传给 `SessionChangesPanel` / 中栏 Diff / 全屏审查 / `@` 路径补全，每个文件夹照常调
  `harness.workspaceList` / `harness.gitDiff`（内核按项目文件夹认目录）。「改动」每个文件夹挂一个 `RepoGitSection`，按 `gitDiff` 返回的
  `gitRoot` 去重；只有一个文件夹时布局与原来一样。`gitDiff` 的 7 条 `git diff` 与 `rev-parse` 在内核里并行跑。
  会话详情的「变更」只要规模，调 `harness.gitSummary`（`status` + `diff --numstat HEAD` 两条命令，不带 diff 原文），
  同一目录的进行中请求共用。窗口重新拿到焦点时的重读（改动、分支、上游、worktree）都经 `utils/focusRefresh.ts`，至多每 5 秒一次。
- **委派与任务**：`delegate_to_cli` / `delegate_to_nomi` 把项目带进新标签与任务（`ExecutorSpec.Project`），Nomi 后台任务经 `extra.projectId` 走同一条路。
- **文件预览**：会话里的文件链接经 `harness.previewOpen` 打开。文件不在会话工作目录里、但在某个项目的文件夹里（同项目的其余文件夹、别的项目）时，
  内核按 `resourcepreview.Service.ProjectRoots` 取那个项目此刻可用的文件夹，选包含它的最深的一个当可编辑根，不再要求逐个文件授权；
  不在任何项目里的仍要用户确认，确认后只读。
- **迁移**：`migrateToProjects` 把会话元信息里的 `cwd`、标签与后台任务的目录各建成单文件夹项目，会话改成引用 projectId。
  `projects.json` 不存在或 `userData/projects-migration.pending` 还在（上次中途失败）时整套跑，每一步都可以重复做，全部成功才删标记。
  只有迁上项目的对话才去掉 `cwd`；目录此刻不能用（外接盘没挂、网络目录离线）的保留 `cwd`，之后每次启动再试。

## 权限档位

清单里的档位：`plan`、`manual`、`acceptEdits`、`auto`、`bypass`（`packages/cli-catalog/src/manifest.ts`），每个 CLI 把它们映射成
自己的启动参数或会话模式（ACP 的 `session/set_mode`）。需要确认的工具调用进编排器的权限队列（`permissionqueue.go`），
视图里回答；回答可以是多选项（允许一次 / 本会话 / 拒绝）。

结构化提问不进权限队列，走 `internal/core/askuser` 的问题卡（对话输入栏上方，10 分钟超时）：Claude Code 的
`AskUserQuestion`、Codex app-server 的 `item/tool/requestUserInput`、Codex 的表单式 `mcpServer/elicitation/request`，
以及 ACP 的 `elicitation/create`（握手时广告 `elicitation.form`）。回答、跳过、取消、超时按各协议的结果写回。
Codex 把 MCP 工具审批包成 elicitation 时（`codex_approval_kind: mcp_tool_call`）仍走允许 / 拒绝；URL elicitation 直接取消。
Codex 的 exec 回退没有来回通道。Nomi 自己连上的 MCP 不广告 elicitation，也不进这张卡。

## 来源与标签令牌

- **官方**：CLI 用它自己的登录态（可以在 Nomi 里管理多个官方账号，见 `accounts/`）。
- **第三方**：CLI 指向本机统一网关。启动前编排器签一个 `nomi-tab-` 令牌并登记绑定（标签、代次、模型、思考深度），收到确认才启动；
  换模型、换第三方供应商时重新登记，下一轮生效。

## 子任务（Nomi 委派的标签）

- 子任务会话（`packages/ai-chat/src/components/SubagentPane` 的返回条，状态在 `contexts/SubagentPaneContext`）：
  点「查看」把这个委派标签激活成当前标签，主对话列走编程助手标签同一条 `CliConversation` + `MessageInput`。
  运行中发送走 `harness.tabSteer`（不支持时排队到这一轮结束），空闲时 `harness.tabSend`，停止 `harness.tabCancel`。
  返回条切回来源标签。设计见 [docs/design/subagent-chat-parity.md](../design/subagent-chat-parity.md)。
- 接手：只有委派正在跑时用户发消息才算接手（打断 Nomi 的这一轮，`delegation.takenOver`）；空闲时发消息就是接着对话，不标接手。
- 回报：`TabFinished.Origin` 记这一轮是谁发起的（`user` / `sandbox` / 程序）。用户自己发的、沙箱授权后续跑的轮次，
  `coding_wiring.go` 交给 `delegate.ReportFollowUp`，经 `delegate.completed`（`followUp: true`）回到来源对话；委派自己的轮次由 `finalize` 回报。

## 本机保护

工作目录策略、环境变量清理、Codex 联网默认关、系统级沙箱与按会话授权：见 [security.md「编程助手」](security.md#编程助手cli-子进程)。

## 测试

- 假 CLI 在仓库根 `scripts/mock-cli/mock-<cli>.mjs`。`NOMI_USE_MOCK_CLI=1` 时 `cli.MockCliBin` 从当前目录往上找 `scripts/mock-cli`（`pnpm dev` 的工作目录是 `apps/desktop-go` 也能找到），用它代替真实 CLI。文件不在就当没安装。
- 编排器、驱动、插件的单测都在各自包里（`go test ./internal/core/cli/... ./internal/clisdk/... ./internal/cliplugins/...`）。
  起子进程的用例按条件等（带说明的超时），不数轮询次数。
