# Agent 看板

Agent 看板列出「谁在干活」：正在回答的 Nomi 对话、Nomi 的后台运行、Nomi 派出的与工坊里的编程助手，以及用户在 Nomi 之外开的
编程助手会话，附带内存与 CPU 占用。任务看板回答「事情做到哪了」，Agent 看板回答「谁在干、占了多少资源、卡在哪」，两者互相链接。

内核在 `apps/desktop-go/internal/core/fleet`，契约是 `coding` 域的 `fleet.state` / `fleet.archive` 与 `fleet.changed` 事件
（`packages/contract/src/app/coding.ts`），处理函数在 `internal/core/codinghandlers/fleet.go`，装配在 `fleet_wiring.go`。
视图在 `packages/ai-chat/src/components/Fleet`。

## 入口

- 左侧导航栏的「Agents」（与任务、素材库并列），打开整页看板；图标带要你处理的角标、在跑的数量与负载环。
- 标题栏左侧、侧栏收起按钮后面的负载指示：在跑的数量 · 总占用 · 整机 CPU，点开浮层看正在跑的，再进完整看板。
  侧栏收起时会话名让出它的宽度（`--cd-titlebar-lead-w`）。

## 纳管边界

| 对象                                                         | scope      | 能做什么               |
| ------------------------------------------------------------ | ---------- | ---------------------- |
| Nomi 本体（内核与它跑的命令、本地模型）                      | —          | 不是卡片               |
| 正在回答的 Nomi 对话                                         | `managed`  | 只观测                 |
| Nomi 的后台运行（执行者为 `nomi` 的持续任务）                | `managed`  | 可暂停                 |
| 编排器里的 CLI 标签：对话委派、任务派出、工坊里直接用的      | `managed`  | 可暂停                 |
| Nomi 进程树之外的编程助手会话（用户自己在终端 / IDE 里开的） | `external` | 只读，只发预警，不干扰 |

判断依据是进程关系，不是委派标记：标签都在编排器里（工坊里用户自己开的、被用户接手的也算纳管）；外部 = 编程助手监视
（`internal/core/agents`）从本机会话文件认出的会话，不含 Nomi 标签自己的会话：标签用过的会话 id 都记下来（`agents/owned.go`，存
`owned-sessions.json`，30 天没再见到的丢掉），标签关掉、出错换了会话 id、重启之后，Nomi 派出去的会话也不会再以「终端 · 只读」出现。外部会话不出现在任何控制接口里，
以后加暂停 / 停止 / 插话时只接受纳管 id。

「正在回答的对话」来自对话路由（`airouter.Handlers.ActiveChats`）：带 `extra.conversationId` 的流（标题生成等辅助调用不带）；
标题由视图从会话列表里取。Nomi 只是开着不会出现在「进行中」。

## 页面

- 头部：标题、「内存紧张时自动处理」开关、整机内存压力 · 物理内存 · 整机 CPU（负载高时换底色）。
- 面板：状态筛选（全部 / 待进行 / 进行中 / 暂停 / 已完成，带真实条数）、按标题 / 助手 / 目录搜索、按助手类型筛选；
  卡片两列铺开（窄屏一列），同一状态里要你处理的在前。卡片写助手、状态、标题、来源与目录、排队 / 暂停 / 出错原因、
  做完时的总结、多久前有动静与 CPU / 内存；暂停 / 继续放在卡片右上，打开标签 / 任务 / 对话、归档、关闭标签收进「⋯」菜单。
  内核不给完成度，卡片底部的状态条不画百分比：进行中是一段流动的主题色，已完成整条 success。
- 头部下面一行：内存守护最近一次动作（10 分钟内）。
- 底部一栏：调度策略，见下文。
- 面板下面：空闲进程列表。

## 状态

只有四种状态，不保留历史；纳管与外部的放在一起（外部卡片虚线边、没有操作按钮）：

| 状态             | 来源                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 待进行 `todo`    | 排队的标签；排队、还没开标签的 CLI 任务；排队的 Nomi 后台运行                                                                   |
| 进行中 `running` | 在跑的；等授权（`needsYou: permission`）、沙箱拦下（`sandbox`）的也在这列                                                       |
| 暂停 `paused`    | 被冻结的 CLI 标签：内存守护自动暂停的（`paused.by: memory`）、用户手动暂停的（`user`）                                          |
| 已完成 `done`    | 跑完的标签、后台运行与外部会话（外部会话等你回话 = 这一轮答完了，也算这里）；等验收的（`needsYou: accept`）、出错的（`failed`） |

- 待进行的卡片写明为什么还没开始（`queueReason`）：`memory` 内存紧张被内存守护扣着、`retry` 上次失败等重试（`retryAt`）、
  `slot` 等前面的任务（并发名额满、每小时启动次数到了，或编排器里同时运行的标签满了）。平时派出去的立刻开始，「待进行」多半是空的。
- 从没跑过的空标签、`idle` 的持续任务（等下次触发）、`idle` 的外部会话不上看板；标着在跑但进程已经没了的外部会话算已完成。
- 已完成的可以归档（`fleet.archive`）：只从看板上拿掉，标签与会话不动，之后再跑起来会重新出现；还要用户处理的不能归档。
  归档只记在内存里。已完成的两小时没动静自动不再显示。

## 资源占用

- 进程表（`internal/core/agents/proctable.go`）一次读出全部进程的父进程、常驻内存与累计 CPU 时间（macOS / Linux 用 `ps`，
  Windows 用 `Win32_Process`）。单个 agent 的 CPU = 两次采样的累计时间差 ÷ 间隔（100 = 占满一个核，同活动监视器的「% CPU」列）；
  不用 ps 的 `%cpu`。
- 整机 CPU（`system.cpuPercent`，0–100，占全部核的比例，同活动监视器的「系统 + 用户」）读系统计数（`agents.SystemCPU`：
  macOS `host_statistics`、Linux `/proc/stat`、Windows `GetSystemTimes`）；读不到（如不带 cgo 的 macOS 构建）时退回各进程相加
  除以核数，会漏掉采样间隔里退出的进程与 `kernel_task`。
- 标签的进程：编排器在 `spawnCLI` 里记下每个标签起的进程（`Orchestrator.TabPids`），从进程表展开整棵树；同一个进程只算一次。
- Nomi 本体 = Nomi 自己的进程树减去各标签的树。Nomi 对话与后台运行跑在内核进程里，单独的占用量不出来，所以没有 `usage`。
- 外部：编程助手进程按进程树归并（`agents.AgentTrees`，一个助手里又起的助手算进同一棵树）；登记了当前会话的进程
  （Claude Code 的 `~/.claude/sessions/<pid>.json`，`agents.Service.ProcSessions`）只归自己的会话，会话还没有会话文件
  （刚开、没发消息）就算空闲，不按目录去认领别的旧会话；其余的由外部会话认领同种助手、
  同一工作目录（`agents.Service.ProcCwds`）的一棵树，在跑的先认领。认领不到的（终端 / IDE 里开着但没在跑会话的）放进 `externalIdle.items`，
  面板下面单独一个「空闲进程」列表，每个一行。

## 手动关闭空闲进程

外部的一律只读，唯一的例外是用户自己点「关闭」关掉一个空闲进程（`fleet.closeIdle`，`dangerous`）：先确认对话框；内核重新读
进程表，确认这个 pid 此刻仍是同一种助手的空闲树的根、不在 Nomi 的进程树里（开始跑会话了、退出了、pid 被别的程序复用了都返回
`FLEET_NOT_IDLE`），再对整棵树发 SIGTERM（子进程在前），过 3 秒还在的发 SIGKILL。核对只认点关闭之后读到的进程表：读失败
（Windows 上 PowerShell 超时等）再读一次，仍读不到就返回 `FLEET_CLOSE_UNVERIFIED`，一个信号都不发，不拿看板缓存的旧表去核对。
调度与内存守护从不调用它。

## 采样

- 采样只在调用时做，1 秒内复用；视图打开看板或浮层时 3 秒拉一次 `fleet.state`，平时 15 秒，窗口隐藏时不拉。
  `fleet.changed` 在标签、任务、外部会话或对话的流开始 / 结束时推。
- 已知限制：`ps` 的常驻内存不含被系统压缩的部分；Linux 的进程 CPU 时间只到秒；Windows 读一次进程表较慢。

## 调度策略

`internal/core/fleet/policy.go`。Nomi 派出去的编程助手与后台任务合计同时运行的上限，用户在看板底部三选一（`fleet.setPolicy`，
和自动处理开关一起存在 `fleet/settings.json`），立即生效：

| 档位            | 同时运行                                                                   |
| --------------- | -------------------------------------------------------------------------- |
| 省资源 `saver`  | 合计最多 5 个                                                              |
| 均衡 `balanced` | 合计最多 10 个（默认）                                                     |
| 全速 `max`      | 不限个数：内存压力偏高 / 紧张、或整机 CPU ≥ 85% 时新的排队，缓下来自动开始 |

「同时运行」是同步委派与持续任务（含后台委派）的合计：两边都设成这个数（`delegate.SetMaxParallel` /
`tasks.Runtime.SetMaxConcurrent`），各自判断时把对方在跑的算进来（`SetSharedLoad`，读对方的原子计数，不拿对方的锁），
一边空出名额就让另一边再排一次队（`SetOnFreed`）。用户自己开的标签、外部终端 / IDE 里的会话不算。固定上限的两档超出的排队
（看板「待进行」标 `queueReason: slot`），不拒绝；调小时正在跑的不打断，调大时排队的马上开始。全速档按资源扣着
（`Holding`，不看自动处理开关；整机 CPU 由内存守护每 5 秒用 `agents.SystemCPU` 的计数差算），排队原因写 `memory` / `cpu`；
前台对话里的同步委派这时返回 `memory_pressure`。持续任务每小时最多启动 30 次的防失控上限不随档位变。档位与数值由内核在
`fleet.state` 的 `policy` / `policyOptions` 里给，视图照着写。

## 内存守护

`internal/core/fleet/governor.go`。每 5 秒读一次系统内存压力（`agents.SystemMemory`：macOS 用系统给的
`kern.memorystatus_vm_pressure_level` 与 `kern.memorystatus_level`；Linux 用 `MemAvailable` 与 PSI；Windows 用
`GlobalMemoryStatusEx`，可用 < 15% 告警、< 7% 危险），只动纳管的 CLI 标签，外部的从不碰。看板右上角的开关
（`fleet.setAutoPause`，存在 `userData/fleet/settings.json`，默认开）关掉时不自动动手，并恢复内存守护暂停的标签。

| 压力                 | 动作                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 告警及以上           | 立刻回收空闲 ≥ 1 分钟的标签的 CLI 进程（`Orchestrator.ReclaimIdleNow`，与空闲回收同一套条件，会话留着，无损）；压力不退时每分钟一次 |
| 危险                 | 每 10 秒冻结一个正在跑的标签：Nomi 派出的（对话委派、任务）先于工坊里的，同类里内存大的先；刚恢复 2 分钟内的不冻                    |
| 回到正常并稳定 30 秒 | 每 20 秒恢复一个内存守护暂停的（最早暂停的先）；用户手动暂停的不自动恢复                                                            |

冻结 = SIGSTOP / `NtSuspendProcess`（`Orchestrator.FreezeTab`，进程树由看板从进程表展开，父进程在前）：不占 CPU，
内存由系统按需压缩换出；恢复（`ThawTab`，子进程在前）后这一轮从原处接着跑，委派与持续任务察觉不到（持续任务的单次
时长预算照常计时）。冻结的进程收不到中断、也答不了话，所以停止、关闭、发消息、插话、审批、拆进程之前编排器都先恢复，
退出时（`Dispose`）恢复全部。卡片上可以手动「暂停 / 继续」（`fleet.pause` / `fleet.resume`）。看板头部下面一行显示
内存守护最近一次动作（10 分钟内）。Nomi 对话与后台 agent 跑在内核进程里，不能冻结。

## Nomi 调度

- 工具（`internal/core/fleet/tools.go`，注册进 Nomi 的工具表，说到 agent / 内存 / 卡 / 暂停 / 派出去的事时才提供）：
  `list_agents`（压力、可用比例、整机 CPU、Nomi 自己的占用与所有 agent，外部的标 `readOnly`）、`pause_agent` /
  `resume_agent`（只对纳管的、可暂停的；外部的、内核里跑的、等用户处理的都拒绝并说明原因）。Nomi 暂停的
  （`paused.by: nomi`）与内存守护暂停的一样，内存恢复正常后自动继续，不会被遗忘在暂停里。
- 内存紧张（critical）且自动处理开着时，内存守护扣着新的工作：任务运行时开始执行前问 `Admit`
  （`tasks.Runtime.SetAdmit`），编程助手与后台 Nomi 的任务留在队列里（看板「待进行」标 `queueReason: memory`），只发通知的照常；
  不再紧张时马上再排一次队（`OnRelease` → `Runtime.Tick`）。同步委派：后台 Nomi 里的等缓解，前台对话里的返回
  `memory_pressure`，让 Nomi 改成后台委派。派活规则的提示词里有一句：电脑卡 / 一次派好几个时先 `list_agents`。
- 调度树：后台 Nomi 运行的 ctx 上有任务 id（`tasks.WithRunTask`），它里面委派出去的编程助手标签记下 `parentTaskId`，
  看板卡片上显示「由「…」派出」（`parentId`）。

## 线程

`fleet.*` 不进 GIL：持续任务的 `Runtime.List` 在 GIL 外读（运行时的持有者可能在等 GIL），读标签与编程助手监视时才
`jsrt.Call` 进 GIL。对话路由的流开始 / 结束在另一个 goroutine 里通知，不阻塞流。
