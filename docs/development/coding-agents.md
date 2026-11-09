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

内核里所有要按 CLI 区分的东西都从 `internal/cliplugins/builtin` 取，不在各处写死名单：

| 要什么                                        | 从哪取                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 有哪些内置 CLI                                | `builtin.IDs`（按 id 排序，与 `ids.ts` 一致）、`builtin.Ordered`（界面与名单的顺序）          |
| 插件能力（权限、账号、历史、斜杠命令、终端…） | `builtin.Impl(id)`（各插件的 `CreateMain()`，只建一次）                                       |
| 显示名                                        | `builtin.DisplayName`（「Gemini」）、`builtin.FullName`（「Gemini CLI」：看板、用量、灵动岛） |
| 清单能力位、传输、可执行文件、npm 包          | `builtin.Capability`、`builtin.UsesAcp`、`builtin.Binaries`、`builtin.NpmPackage`             |
| 按能力筛的名单                                | `builtin.Where(builtin.WithAccounts / WithHistory / WithQuota / All)`                         |
| 不在清单里的少数信息                          | `builtin.Entry`：会话记录解析、最低 Node 版本、自更新方式、官方厂商、ACP 启动参数、计划后续   |

视图侧对应 `@nomi-ai/cli-catalog` 的 `BUILTIN_CLI_ORDER` 与 `cliCapability`。两个守卫测试拦下写死的名单（同一行出现 3 个及以上
内置 id）：Go 侧 `internal/cliplugins/builtin/hardcoded_test.go`，视图侧 `packages/cli-catalog/tests/no-hardcoded-lists.test.ts`；
确实只属于某几个 CLI 的实现（额度查询、用量日志解析、品牌图标）登记在测试里的白名单并写明原因。Go 与视图两份清单都和
`internal/cliplugins/builtin/testdata/b7s2-plugins.json` 比（`manifest_parity_test.go`、`manifests-parity.test.ts`）。

加一个内置助手（以 ACP 为例）：

1. `packages/cli-catalog/src/<id>/`：`manifest.ts`（`transport: 'acp'`、能力位、权限档位映射）与 `renderer.ts`，跑 `gen:ids`；
   在 `BUILTIN_CLI_ORDER` 末尾加上它。
2. `apps/desktop-go/internal/cliplugins/<id>/`：`manifest.go`（与 TS 一致）与 `CreateMain()`（官方启动、权限、账号目录；
   没有的能力留空）；在 `builtin.entries` 登记一条，`builtin.Ordered` 末尾加上它。
3. 更新 `testdata/b7s2-plugins.json`，补中英文文案、品牌图标与文档。

之后名单、显示名、检测、安装与更新、看板认进程、委派、ACP 启动都自动带上它；额度查询、用量日志、第三方模型（网关）
要用时再在各自的地方补实现。

## 权限档位

清单里的档位：`plan`、`manual`、`acceptEdits`、`auto`、`bypass`（`packages/cli-catalog/src/manifest.ts`），每个 CLI 把它们映射成
自己的启动参数或会话模式（ACP 的 `session/set_mode`）。需要确认的工具调用进编排器的权限队列（`permissionqueue.go`），
视图里回答；回答可以是多选项（允许一次 / 本会话 / 拒绝）。

## 来源与标签令牌

- **官方**：CLI 用它自己的登录态（可以在 Nomi 里管理多个官方账号，见 `accounts/`）。
- **第三方**：CLI 指向本机统一网关。启动前编排器签一个 `nomi-tab-` 令牌并登记绑定（标签、代次、模型、思考深度），收到确认才启动；
  换模型、换第三方供应商时重新登记，下一轮生效。

## 子任务（Nomi 委派的标签）

- 子任务面板（`packages/ai-chat/src/components/SubagentPane`，状态在 `contexts/SubagentPaneContext`，与变更 / 文件查看区独立）：
  运行中发送走 `harness.tabSteer`（不支持时排队到这一轮结束），空闲时 `harness.tabSend`，停止 `harness.tabCancel`。
- 接手：只有委派正在跑时用户发消息才算接手（打断 Nomi 的这一轮，`delegation.takenOver`）；空闲时发消息就是接着对话，不标接手。
- 回报：`TabFinished.Origin` 记这一轮是谁发起的（`user` / `sandbox` / 程序）。用户自己发的、沙箱授权后续跑的轮次，
  `coding_wiring.go` 交给 `delegate.ReportFollowUp`，经 `delegate.completed`（`followUp: true`）回到来源对话；委派自己的轮次由 `finalize` 回报。

## 本机保护

工作目录策略、环境变量清理、Codex 联网默认关、系统级沙箱与按会话授权：见 [security.md「编程助手」](security.md#编程助手cli-子进程)。

## 测试

- 假 CLI 在 `scripts/mock-cli/mock-<cli>.mjs`（`NOMI_USE_MOCK_CLI=1` 时 `cli.MockCliBin` 从当前目录下的 `scripts/mock-cli` 找它代替真实 CLI）。
- 编排器、驱动、插件的单测都在各自包里（`go test ./internal/core/cli/... ./internal/clisdk/... ./internal/cliplugins/...`）。
  起子进程的用例按条件等（带说明的超时），不数轮询次数。
