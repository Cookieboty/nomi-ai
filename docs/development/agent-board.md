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

| 对象                                                         | scope      | 能做什么                   |
| ------------------------------------------------------------ | ---------- | -------------------------- |
| Nomi 本体（内核与它跑的命令、本地模型）                      | —          | 只在总览里给占用，不是卡片 |
| 正在回答的 Nomi 对话                                         | `managed`  | 只观测                     |
| Nomi 的后台运行（执行者为 `nomi` 的持续任务）                | `managed`  | 可暂停                     |
| 编排器里的 CLI 标签：对话委派、任务派出、工坊里直接用的      | `managed`  | 可暂停                     |
| Nomi 进程树之外的编程助手会话（用户自己在终端 / IDE 里开的） | `external` | 只读，只发预警，不干扰     |

判断依据是进程关系，不是委派标记：标签都在编排器里（工坊里用户自己开的、被用户接手的也算纳管）；外部 = 编程助手监视
（`internal/core/agents`）从本机会话文件认出的会话，不含 Nomi 标签自己的会话。外部会话不出现在任何控制接口里，
以后加暂停 / 停止 / 插话时只接受纳管 id。

「正在回答的对话」来自对话路由（`airouter.Handlers.ActiveChats`）：带 `extra.conversationId` 的流（标题生成等辅助调用不带）；
标题由视图从会话列表里取。Nomi 只是开着不会出现在「进行中」。

## 分列

只有四列，不保留历史；纳管与外部的放在同一套列里（外部卡片虚线边、没有操作按钮）：

| 列               | 来源                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| 待进行 `todo`    | 排队的标签；排队、还没开标签的 CLI 任务；排队的 Nomi 后台运行                                          |
| 进行中 `running` | 在跑的；等授权（`needsYou: permission`）、沙箱拦下（`sandbox`）、外部会话等你回话（`reply`）的也在这列 |
| 暂停 `paused`    | 预留给内存调度（P2）                                                                                   |
| 已完成 `done`    | 跑完的标签、后台运行与外部会话；等验收的（`needsYou: accept`）、出错的（`failed`）                     |

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
- 外部：编程助手进程按进程树归并（`agents.AgentTrees`，一个助手里又起的助手算进同一棵树）；在跑的外部会话认领同种助手、
  同一工作目录（`agents.Service.ProcCwds`）的一棵树。认领不到的（终端 / IDE 里开着但没在跑会话的）合并成 `externalIdle`，
  在总览里一行显示。
- 采样只在调用时做，1 秒内复用；视图打开看板或浮层时 3 秒拉一次 `fleet.state`，平时 15 秒，窗口隐藏时不拉。
  `fleet.changed` 在标签、任务、外部会话或对话的流开始 / 结束时推。
- 已知限制：`ps` 的常驻内存不含被系统压缩的部分；Linux 的进程 CPU 时间只到秒；Windows 读一次进程表较慢。

## 线程

`fleet.*` 不进 GIL：持续任务的 `Runtime.List` 在 GIL 外读（运行时的持有者可能在等 GIL），读标签与编程助手监视时才
`jsrt.Call` 进 GIL。对话路由的流开始 / 结束在另一个 goroutine 里通知，不阻塞流。
