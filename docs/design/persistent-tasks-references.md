# 持续任务与连接：参考与取舍

> 调研日期 2026-11-01。所有结论来自下列项目的官方文档或源码（链接见各节），许可证用 GitHub API 与仓库 LICENSE 文件核对。
> 相关：[持续任务](persistent-tasks.md)、[连接](connections.md)、[实施计划](persistent-tasks-plan.md)。
> 本文只借鉴**设计与语义**；需要借用代码时，只从许可证兼容 MIT 的项目借，并登记 `CREDITS.md`。

## 1. 参考了哪些项目

| 项目                            | 许可证（核对方式）                                        | 借鉴范围               |
| ------------------------------- | --------------------------------------------------------- | ---------------------- |
| Temporal（server / TS SDK）     | MIT（GitHub API）                                         | 语义；代码可借         |
| Trigger.dev                     | Apache-2.0（GitHub API）                                  | 语义；代码可借         |
| Hatchet                         | MIT（GitHub API）                                         | 语义                   |
| BullMQ                          | MIT（GitHub API）                                         | 默认值（源码）         |
| Huginn                          | MIT（GitHub API）                                         | 事件源去重（源码）     |
| dsh-superagent-prototype        | MIT（GitHub API）                                         | 授权、执行、恢复、面板 |
| Goose（aaif-goose/goose）       | Apache-2.0（GitHub API）                                  | 本机定时（源码）       |
| LangGraph                       | MIT（GitHub API）                                         | 人工介入语义           |
| MCP 规范 2026-07-28、Tasks 扩展 | 规范                                                      | 连接的 OAuth、长任务   |
| GitHub REST / `gh` 手册         | 文档                                                      | GitHub 连接            |
| Inngest                         | 服务端 SSPL-1.0，`inngest-js` **GPL-3.0**（LICENSE 文件） | **只看文档，不借代码** |
| Nango                           | Elastic License 2.0                                       | 不借代码               |
| Restate                         | BSL 1.1                                                   | 不借代码               |
| Windmill                        | 默认 AGPLv3，部分 Apache-2.0，含专有部分                  | 不借代码               |
| n8n、Multica                    | 附加条件许可（n8n fair-code；Multica 见分析文档）         | 不借代码               |

## 2. 发现与对设计的改动

每条：**事实**（出处）→ **对我们意味着什么** → **改动**。

### 2.1 等人的执行不占并发名额

- 事实：
  - Inngest：并发上限只算「正在执行代码的步骤」，`sleep` / `waitForEvent` 等待时不占名额，恢复后要重新排队拿名额
    （[concurrency](https://www.inngest.com/docs/guides/concurrency)）。
  - Trigger.dev：进入 `WAITING`（在 waitpoint 处被 checkpoint）的 run 不占名额；恢复时「must re-acquire its slots」
    （[queue-concurrency](https://trigger.dev/docs/queue-concurrency)）。
  - dsh 原型：交给人处理（ready / 提问 / blocked / failed）时**立即释放**名额；另外为「人的消息」**多留一个名额**，
    这样新工作永远不会挡住人继续推进已有工作（`docs/003-execution.md`「Concurrency」）。
- 改动：`waiting_user` 释放并发名额；用户回应后恢复执行**走预留的「人工名额」**（全局 +1），不和新触发抢。
  状态机：`needs_user` 产生 `release_slot`；`decide` 产生 `acquire_slot { reserved: true }` 再 `resume_attempt`。

### 2.2 定时触发碰上正在执行：默认跳过

- 事实：Temporal Schedules 的重叠策略默认 `Skip`（正在跑就不启动新的），另有 `BufferOne` / `BufferAll` /
  `CancelOther` / `TerminateOther` / `AllowAll`；补跑窗口默认一年，最短 10 秒
  （[schedule](https://docs.temporal.io/schedule)）。
  Goose 的定时到点**不检查**是否正在运行（`crates/goose/src/scheduler/full.rs`，只有手动 run 会拒绝），即事实上 AllowAll。
- 改动：写明重叠策略——**定时：Skip**（记一条「已跳过：上次还在跑」）；**事件：合并进下一次**（相当于 BufferOne，
  见 2.6）。补跑窗口保持现有的 12 小时（产品语义：过了半天的日报没意义），不跟 Temporal 的一年。

### 2.3 重试：瞬时错误重试 3 次，指数退避

- 事实：
  - Temporal 活动默认：初始 1 秒、系数 2.0、最长间隔 100 秒、次数不限；有「不可重试错误类型」；
    **工作流本身默认不重试**，建议在里面重试活动（[retry-policies](https://docs.temporal.io/encyclopedia/retry-policies)）。
  - dsh 原型：模型供应商或网络的瞬时错误（HTTP 408、429、5xx，连接被拒 / 重置 / 超时）先重试 **3 次**，退避递增；
    准备命令失败不重试（`003-execution.md`「Executor blocked or failed」）。
- 改动：设计稿原来的「重试一次」改为**瞬时错误最多 3 次**，退避 2 秒起翻倍、封顶 60 秒（与 dsh 的投递退避一致）；
  `TaskErrorCode` 每个码标 `retryable`，瞬时错误清单按上面 dsh 的列表。`Budget.maxRetries` 默认 3。

### 2.4 重复任务连续失败要自动暂停

- 事实：Temporal Schedules 有 pause-on-failure（失败或超时后自动暂停这个 Schedule）；dsh 原型的事件源连续 3 次失败
  才报错，成功一次清零（`003-execution.md`「Source failure」）。
- 改动：任务新增 `consecutiveFailures`；重复任务**连续失败 3 次自动暂停**并进收件箱（「已暂停：连续 3 次失败」），
  成功一次清零。

### 2.5 重启恢复：日志 + 恢复说明，等人的保持原样

- 事实：
  - Temporal：活动是「至少一次」执行，可能执行多次甚至多次部分完成；建议用「Workflow Run ID + Activity ID」做幂等键
    （[activity-definition](https://docs.temporal.io/activity-definition)）。
  - LangGraph：从 `interrupt()` 恢复时**整个节点从头重跑**，中断前的副作用必须可重复，非幂等写放在中断之后
    （[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)）。
  - dsh 原型：重启时运行中的工作以「host restarted」结束，新工作带一段**恢复说明**——先检查目录、git 历史和 GitHub
    再决定是否重复任何对外动作；**等人的、待验收的、blocked / failed 的保持原样**（`003-execution.md`「Restart」）。
  - Goose：启动时直接清掉「运行中」标记，不恢复（`full.rs` `clear_running_state`）——这是我们要避免的反例。
- 改动：
  1. 保留设计稿的 intent / done 日志（比 dsh 只靠模型自查更可靠），**同时**给续跑的执行加恢复说明（已完成的对外动作、
     中断位置、「重复对外动作前先核对」）。
  2. 幂等键定为 `taskId:attemptId:seq`（同 Temporal 的思路）。
  3. **重启时 `waiting_user` 保持原样**：问题不丢、不重新问一遍；用户回答后以 `resume` 新开一次执行，把回答写进恢复说明。
     （原状态机草稿是重启即重新排队，会让用户被问第二遍，改掉。）

### 2.6 事件合并：用「批处理」语义，不用「防抖」

- 事实：Inngest 的 debounce 只把**最后一个**事件交给函数；batching 把窗口内的事件**全部**交给函数，按 `maxSize` 或
  `timeout` 先到者开跑，第一个事件开窗口
  （[debounce](https://www.inngest.com/docs/guides/debounce)、[batching](https://www.inngest.com/docs/guides/batching)）。
- 改动：我们要处理一串评论里的每一条，所以 `cooldownMs` 明确为**批处理**：第一个事件开窗口，窗口结束或攒满
  `maxBatch`（默认 20）就开一次执行，带上全部事件。

### 2.7 去重记多少

- 事实：Huginn 的 RSS 代理默认记 500 个已见 id（`remembered_id_count`）；去重代理默认回看 100 个（`lookback`）；
  网页代理 `on_change` 模式比对最近的若干事件（`app/models/agents/*.rb`）。
  Trigger.dev 的幂等键：进行中 → 忽略；已完成 / 已取消 → 返回原 run；失败 / 过期 → 释放，可以重新触发
  （[runs](https://trigger.dev/docs/runs)）。
- 改动：每个任务记最近 **500** 个已处理的事件 `key`；事件对应的那次执行**失败**时释放该 key（下次还能触发），
  成功或取消则保留。

### 2.8 取消是协作式的

- 事实：Inngest 取消时**正在执行的步骤会跑完**，已完成的副作用不回滚，并发出取消系统事件供清理
  （[cancellation](https://www.inngest.com/docs/features/inngest-functions/cancellation)）；MCP Tasks 的取消同样是
  协作式，任务可能仍以非取消的终态结束（[Tasks](https://modelcontextprotocol.io/extensions/tasks/overview)）。
- 改动：写明 `stop_attempt` 是协作式；取消后到达的 `intent` / `done` **照常写进日志**（审计要完整），只是结果不再投递；
  取消后产生的清理（保留 worktree 等）作为单独的效果。

### 2.9 卡住与超时

- 事实：BullMQ 默认锁 30 秒、`stalledInterval` 30 秒、`maxStalledCount` 1（超过即失败）（`src/classes/worker.ts`）；
  Trigger.dev 有 `maxDuration`，超了是单独的 `Timed out` 状态，排队太久有 TTL → `Expired`（[runs](https://trigger.dev/docs/runs)）；
  dsh 原型一轮结束后后台工作最多再给 30 分钟。
- 改动：执行者定期上报心跳（进度时间戳）；超过 `maxDurationMsPerAttempt` 记错误码 `timed_out`（不可重试，进收件箱）；
  进程心跳丢失按 `executor_crashed`（可重试）处理，同一次执行最多判一次。

### 2.10 投递（Outbox）

- 事实：dsh 原型「先存再做」：所有决定后的动作先存储再执行；投递失败 2 秒起翻倍、封顶 1 分钟重试；连续失败 3 次才显示为
  系统问题；同一工单发往同一会话的消息**保序**；丢弃的消息保留记录与原因，不会重新入队（`003-execution.md`「Stored work」「Channel failure」）。
- 改动：Outbox 采用同样的退避、「连续 3 次失败才报错」、按任务保序、丢弃留档。

### 2.11 授权与「只记录」模式

- 事实：dsh 原型的接受模式是 `off` / `observe`（默认）/ `auto`；`observe` 下肯定的判断记为「本会接受」但不执行；
  订阅送来的消息「grants no new authority」；Policy 有版本，变更后**不立即撤销**进行中的工作，而是在恢复前重新校验
  （`002-authorization.md`）。
- 改动：我们的 `observe` / `act` 对应它的 `observe` / `auto`（`off` = 任务停用，不另设）；observe 下记录「本会执行」。
  **不跟**它「变更后再校验」的做法：我们的授权收窄立即生效（设计稿 §8.3），对本机代码与账号更安全；这是有意的差异。

### 2.12 收件箱的状态分类

- 事实：dsh 原型面板的阶段表「自上而下，第一条匹配的胜出」，分类互斥且覆盖全部情况；标签写「在等谁、需要什么」，
  不写内部状态码；健康状态不占空间（`003-execution.md`「Ticket stages」、`005-panel.md`「Principles」）。
- 改动：收件箱与任务列表按同样原则：分组按优先级取第一条匹配；标签用「等你批准」「等你验收」「需要核对」，不显示状态码。

### 2.13 GitHub 连接

- 事实：
  - **通知接口只支持经典 PAT**（「only support authentication using a personal access token (classic)」），需要
    `notifications` 或 `repo` scope；轮询要遵守 `X-Poll-Interval`，用 `Last-Modified` / `If-Modified-Since`，
    304 不消耗额度（[notifications](https://docs.github.com/en/rest/activity/notifications)）。
  - REST 最佳实践：304 只有**带 Authorization 头**时才不计入额度；请求要**串行**；有 `retry-after` 按它等，
    `x-ratelimit-remaining` 为 0 等到 `x-ratelimit-reset`，否则至少等 1 分钟再指数退避；批量写请求间隔至少 1 秒
    （[best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)）。
  - `gh`：`GH_TOKEN` / `GITHUB_TOKEN` 优先于已存的登录；GHES 用 `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN`；
    `GH_CONFIG_DIR` 指定配置目录；`GH_PROMPT_DISABLED` 关交互（[environment](https://cli.github.com/manual/gh_help_environment)）。
    登录令牌默认存系统凭据库，失败才回落明文文件；经典令牌最少要 `repo`、`read:org`、`gist`
    （[auth login](https://cli.github.com/manual/gh_auth_login)）。
  - 本机实测 `gh` 2.103.3：`gh auth status --json hosts` 返回 `active`、`gitProtocol`、`host`、`login`、`scopes`、
    `state`、`tokenSource`，**不含令牌**；默认会自动刷新快过期的令牌，`--no-refresh` 可关。
- 改动（[connections.md](connections.md) §4）：
  1. 检测用 `gh auth status --json hosts --no-refresh`（只读、不改动用户的登录）。
  2. 「推荐细粒度令牌」要改说法：细粒度令牌**用不了通知接口**。通知类事件源需要经典权限——复用 `gh` 登录正好满足；
     粘贴令牌时，只观察指定仓库的 issue / PR / 评论可以用细粒度令牌（按仓库轮询，`since` + ETag）。
  3. 子进程隔离要去掉的变量补上 `GITHUB_ENTERPRISE_TOKEN`，并设 `GH_PROMPT_DISABLED=1`。
  4. 轮询串行、遵守 `X-Poll-Interval` / `retry-after` / `x-ratelimit-reset`，写请求间隔 ≥ 1 秒。
  5. **如实说明边界**：dsh 原型明确写「这些包装和目录只是默认值，不是安全边界」（worker 仍可按绝对路径执行程序）。
     我们的 `GH_CONFIG_DIR` 隔离同理——编程助手仍可能用其他方式读到钥匙串里的令牌。真正的边界是命令审核：
     `gh auth token`、`gh auth status --show-token`、读系统凭据库的命令（如 macOS `security find-generic-password`）
     在后台任务里一律暂停等人。

### 2.14 MCP 连接

- 事实（规范 2026-07-28）：
  - stdio 服务器**不走** OAuth，从环境变量拿凭据；HTTP 服务器走 OAuth 2.1，PKCE 必须，`resource` 参数必须，
    回跳地址必须是 `localhost` 或 HTTPS，授权响应要按 RFC 9207 校验 `iss`；客户端注册优先 **Client ID Metadata Documents**，
    Dynamic Client Registration 已标为弃用、仅为兼容保留；权限不足（`insufficient_scope`）走逐步提权
    （[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)）。
  - **MCP Tasks 扩展**：服务器可对长时间的调用返回持久的任务句柄，状态 `working` / `input_required` / `completed` /
    `failed` / `cancelled`；客户端轮询 `tasks/get`、用 `tasks/update` 补输入、`tasks/cancel` 协作式取消；
    客户端应**持久保存任务 id**，重启后继续轮询（[Tasks](https://modelcontextprotocol.io/extensions/tasks/overview)）。
- 改动：
  1. **远程 MCP 先不考虑**（2026-11-01 决定）：Nomi 只接本机 stdio MCP 服务器，凭据走环境变量，不实现 OAuth。
     上面 OAuth 的要求留作将来接远程 MCP 时的依据。
  2. Nomi 作为 MCP 客户端支持 Tasks 扩展：`input_required` 映射为任务的 `waiting_user`（input）；MCP 任务 id 写进事件日志，
     重启后**先继续轮询**，查得到结果就不必进 `needs_reconcile`。

## 3. 状态机草稿要改的地方（1.1）

| 改动                                                                      | 依据 |
| ------------------------------------------------------------------------- | ---- |
| `needs_user` 释放名额；`decide` 用预留名额恢复                            | 2.1  |
| 定时触发遇到执行中 → 跳过并记录；事件 → 合并                              | 2.2  |
| 重试上限默认 3，退避 2 秒翻倍封顶 60 秒（运行时算，机器只收 `backoffMs`） | 2.3  |
| `consecutiveFailures`，重复任务连续 3 次失败自动暂停                      | 2.4  |
| 重启时 `waiting_user` 保持；回答后以 `resume` 新开执行                    | 2.5  |
| 错误码 `timed_out`、`executor_crashed`                                    | 2.9  |

## 4. 没有采纳的

| 做法                                                      | 出处                                      | 不采纳的原因                               |
| --------------------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| 工作流引擎 / 外部服务（Temporal 服务端、Redis、Postgres） | Temporal、BullMQ、DBOS                    | 本机零运维；设计稿 §1 不引入数据库         |
| 定时补跑窗口默认一年                                      | Temporal                                  | 过时的日报、提醒没有意义，保留现有 12 小时 |
| 策略变更后再校验、不立即撤销                              | dsh 原型                                  | 本机账号与代码，收窄应立即生效             |
| 执行者无审批地跑命令                                      | dsh 原型（worker 以操作者身份无审批运行） | 与 Nomi 的命令审核和五档权限冲突           |
| 防抖（只取最后一个事件）                                  | Inngest debounce                          | 一串评论都要处理，用批处理语义             |
