# Agent 看板

Agent 看板列出「谁在干活」：Nomi 本体、Nomi 的后台运行、Nomi 派出的与工坊里的编程助手，以及用户在 Nomi 之外开的编程助手，
附带每个的内存与 CPU 占用。任务看板回答「事情做到哪了」，Agent 看板回答「谁在干、占了多少资源、卡在哪」，两者互相链接。

内核在 `apps/desktop-go/internal/core/fleet`，契约是 `coding` 域的 `fleet.state` / `fleet.archive` 与 `fleet.changed` 事件
（`packages/contract/src/app/coding.ts`），处理函数在 `internal/core/codinghandlers/fleet.go`，装配在 `fleet_wiring.go`。

## 纳管边界

| 对象                                                         | scope      | 能做什么                   |
| ------------------------------------------------------------ | ---------- | -------------------------- |
| Nomi 本体（内核与它跑的命令、本地模型）                      | `managed`  | 只观测，不会被停           |
| Nomi 的后台运行（执行者为 `nomi` 的持续任务）                | `managed`  | 可暂停                     |
| 编排器里的 CLI 标签：对话委派、任务派出、工坊里直接用的      | `managed`  | 可暂停                     |
| Nomi 进程树之外的编程助手进程（用户自己在终端 / IDE 里开的） | `external` | 只读占用、只发预警，不干扰 |

判断依据是进程关系，不是委派标记：标签都在编排器里（工坊里用户自己开的、被用户接手的也算纳管）；外部 = 进程表里认出的编程助手
（`agents.Classify`）不在 Nomi 自己的进程树下。外部进程不出现在任何控制接口里，以后加暂停 / 停止 / 插话时只接受纳管 id。

## 分列

只有四列，不保留历史：

| 列               | 来源                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| 待进行 `todo`    | 排队的标签；排队、还没开标签的 CLI 任务；排队的 Nomi 后台运行                                |
| 进行中 `running` | 在跑的；等授权（`needsYou: permission`）、沙箱拦下（`sandbox`）的也在这列；外部 CLI 只在这列 |
| 暂停 `paused`    | 预留给内存调度（P2）                                                                         |
| 已完成 `done`    | 跑完的标签与后台运行；等验收的（`needsYou: accept`）、出错的（`failed`）                     |

- 从没跑过的空标签、`idle` 的持续任务（等下次触发）不上看板。
- 已完成的可以归档（`fleet.archive`）：只从看板上拿掉，标签与会话不动，之后再跑起来会重新出现；还要用户处理的不能归档。
  归档只记在内存里。已完成的两小时没动静自动不再显示。

## 资源占用

- 进程表（`internal/core/agents/proctable.go`）一次读出全部进程的父进程、常驻内存与累计 CPU 时间（macOS / Linux 用 `ps`，
  Windows 用 `Win32_Process`）。CPU 占用 = 两次采样的累计时间差 ÷ 间隔（100 = 占满一个核）；不用 ps 的 `%cpu`。
- 标签的进程：编排器在 `spawnCLI` 里记下每个标签起的进程（`Orchestrator.TabPids`），从进程表展开整棵树；同一个进程只算一次。
- Nomi 本体 = Nomi 自己的进程树减去各标签的树。Nomi 的后台运行跑在内核进程里，单独的占用量不出来，所以没有 `usage`。
- 外部编程助手按进程树归并（`agents.AgentTrees`）：一个助手里又起的助手算进同一棵树。
- 采样只在调用时做，1 秒内复用；视图打开看板时每几秒拉一次 `fleet.state`。`fleet.changed` 只在标签或任务变化时推。
- 已知限制：`ps` 的常驻内存不含被系统压缩的部分；Linux 的 CPU 时间只到秒；Windows 读一次进程表较慢。

## 线程

`fleet.*` 不进 GIL：持续任务的 `Runtime.List` 在 GIL 外读（运行时的持有者可能在等 GIL），读标签时才 `jsrt.Call` 进 GIL。
