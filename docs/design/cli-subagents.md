# 编程助手子代理（subagents）的接管与交互（设计稿）

> 状态：设计稿 + 分阶段实现（见第 7 节进度）。
> 查证 2026-10-19：Claude Code 2.1.303、Codex CLI 0.163.0（真机录制事件）、dsh 0.2.0-rc.2（读源码）、Grok Build 1.0.62（仅二进制，未登录未实测）。
> 平台：macOS / Linux / Windows 同等支持（第 6 节）。
> 相关：[权限模式](cli-permission-modes.md)、[编程助手接入](../features/coding-agent-harness.md)。

## 1. 背景

Claude、Codex 与 dsh 当前能产生统一的子代理事件；Grok 的事件格式仍待真实验证，Gemini 当前不声明子代理能力。Codex 的 `multi_agent` 默认开启。Nomi 原来只把 Claude 子代理内部的工具调用按
`parent_tool_use_id` 嵌套显示，其余情况要么丢事件、要么丢数据：

| 后端   | CLI 给出的子代理信息（实测 / 源码）                                                                                                                                                                                                                                                                                                                                                                                                                        | Nomi 原来的处理                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Claude | 子代理内部消息带 `parent_tool_use_id`；`system` 事件：`task_started`（`task_id`、`tool_use_id`、`description`、`subagent_type`、`is_backgrounded`、`spawn_depth`）、`task_progress`（`description`、`usage.tool_uses / total_tokens / duration_ms`、`last_tool_name`）、`task_updated`（`patch.status`）、`task_notification`（`status`、`summary`、`usage`）、`background_tasks_changed`；控制请求 `stop_task {task_id}`；`can_use_tool` 带 `tool_use_id` | 只嵌套子调用；生命周期事件全丢；后台子代理见下 |
| Codex  | `exec --json` 的 `collab_tool_call` item：`tool` ∈ `spawn_agent / wait / send_input / close_agent`，`sender_thread_id`、`receiver_thread_ids`、`prompt`、`agents_states[thread] = { status, message }`。子代理内部的命令**不进**主流                                                                                                                                                                                                                       | 整个 item 被丢弃：子代理运行期间界面空白       |
| dsh    | 工具 `subagent`（`backgroundMode: continuable`）、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`；无头 JSON 只投影主会话（`session !== agent.session` 直接 return），子代理内部不可见                                                                                                                                                                                                                                                   | 只认 `subagent`，其余显示成普通工具            |
| Grok   | 二进制含 `subagent_id / subagent_spawn / subagent_message / subagent_output / subagent_type` ⚠️ 未实测                                                                                                                                                                                                                                                                                                                                                     | 不明                                           |
| Gemini | 当前 ACP 清单不声明子代理能力                                                                                                                                                                                                                                                                                                                                                                                                                              | 不适用                                         |

### 1.1 两个会丢东西的问题（P0）

1. **Claude 后台子代理（实测）**：`run_in_background: true` 时，主代理立刻结束这一轮（输出 `result`），
   子代理之后继续输出（带 `parent_tool_use_id`），完成后主代理**在没有用户消息的情况下自己开新一轮**
   （第二段回复 + 第二个 `result`）。Nomi 收到第一个 `result` 就认为一轮结束：之后的输出只实时推给界面、
   不落盘；标签显示「空闲」；空闲回收 / 「停止」可能直接杀掉还在跑的后台子代理；两轮之间来的权限请求，
   `replyPermission` 依赖的 `children` 已清空，**允许也写不回去**。
2. **权限请求被覆盖**：渲染层每个标签只有一个 `permission` 位，并行子代理同时请求时后一个覆盖前一个；
   被覆盖的请求在主进程挂到 120 秒后自动拒绝，用户看不到；卡片也看不出是哪个子代理在请求。

## 2. 目标

- 对已声明支持的后端，子代理都**可见**：谁在跑、在做什么、结果是什么；CLI 不给内部步骤时如实说明，不让人以为卡住。未声明支持的后端不显示虚假的子代理状态。
- **不丢数据**：后台子代理与主代理自发的跟进轮次都落盘、计入用量、触发提醒。
- **权限不丢**：并行请求排队、注明来源、可见倒计时、超时可见。
- **可控**：能看到后台还有几个子代理；能单独停止（CLI 支持时）；关闭 / 停止前提示。
- 三平台一致（第 6 节）。

## 3. 统一模型（主进程）

新增实时事件（`HarnessEvent`）：

```ts
| {
    type: 'agent';
    op: 'start' | 'progress' | 'end';
    /** 稳定 id：Claude task_id / Codex receiver thread id / dsh callId */
    id: string;
    /** 派生它的工具调用 id（Claude tool_use_id、Codex collab item id、dsh callId），用来和子调用 / 卡片关联 */
    callId?: string;
    label?: string;        // 描述（description / prompt 首行）
    agentType?: string;    // general-purpose / Explore / …（CLI 给出时）
    background?: boolean;
    status?: 'running' | 'completed' | 'failed' | 'stopped';
    progress?: string;     // 「Read a.txt」之类（Claude task_progress.description / last_tool_name）
    summary?: string;      // 结束时的结果摘要（截断）
    usage?: { toolUses?: number; tokens?: number; durationMs?: number };
  }
```

`permission` 事件增加 `agent?: string`（来源子代理的 label）与 `toolUseId?: string`；新增
`{ type: 'permission-resolved'; id; reason: 'allowed' | 'denied' | 'timeout' }`，超时自动拒绝也通知界面。

标签元数据增加 `background?: number`（仍在运行的后台子代理数，只在内存、随 `ai:harness:tabs` 广播）。

### 3.1 各后端映射

| 后端   | start                                                                   | progress                   | end                                                                                                    | 内部步骤                                                                          |
| ------ | ----------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Claude | `system/task_started`                                                   | `system/task_progress`     | `task_notification`（或 `task_updated.patch.status` 为终态）                                           | 有：`parent_tool_use_id` 嵌套（已有）                                             |
| Codex  | `collab_tool_call(spawn_agent)` 完成时，每个 `receiver_thread_ids` 一个 | `wait / send_input` 进行中 | `agents_states[id].status` 为 completed / failed / closed（`wait` 或 `close_agent`），`message` 作摘要 | 无（卡片注明）                                                                    |
| dsh    | `tool_call(subagent / subagent_fork)`                                   | —                          | 对应 `tool_result`                                                                                     | 无（卡片注明）；`send_message / interrupt_agent / list_agents` 归为对子代理的操作 |
| Grok   | ⚠️ 待实测后补                                                           |                            |                                                                                                        |                                                                                   |

Claude 的 `task_started` 也会为子代理内部的后台 Bash 等发出（`task_type` 非 `local_agent`），只有
`task_type === 'local_agent'`（或带 `subagent_type`）的才算子代理；其它后台任务计入「后台任务」但不出子代理卡片。

## 4. Claude 长驻进程的轮次模型（P0-1）

- 启动参数加 `--replay-user-messages`，每条写入 stdin 的用户消息带 `uuid`。CLI 把它原样回显
  （`type: user`、`isReplay: true`、同一 `uuid`，实测）。
- 进程维护**轮次队列**：用户发送 = 入队一个「用户轮次」；它的回显到达后，之后的输出才归它。
- 没有进行中的轮次、却来了内容事件（assistant 文本 / 工具 / agent 事件）：开一个**自发轮次**
  （`origin: 'background'`）。它的 `result` 到达时落盘一条助手消息（带 `origin`，界面标注
  「后台任务完成后的跟进」），计入用量，发 `tab-finished`（看板娘 / 系统通知）。
- `result` 只结束**当前归属**的轮次；用户消息在自发轮次进行中发送时，等回显到了再切换归属，
  不会把自发轮次的 `result` 错算给用户。
- 后台任务计数：`task_started`（`is_backgrounded`）+1，对应 `task_notification / task_updated` 终态 -1；
  `background > 0` 时：空闲回收跳过；`cancelTab` / 关闭标签由渲染层先确认（「还有 N 个后台子代理」）；
  权限回复改用长驻进程的 stdin（不再依赖 `children`）。
- 停止单个子代理：`stop_task {task_id}`（新 IPC `ai:harness:stop-agent`）。

## 5. 界面（渲染层）

1. **权限队列**（P0-2）：`TabLive.permissions: Array<{ id, summary, agent?, since }>`；对话区显示第一项，
   其余以「还有 N 项待确认」展开；每项标注来源（「子代理 · 读取 a.txt」）和剩余秒数；`permission-resolved`
   移除对应项，超时时短暂提示「已超时自动拒绝」。
2. **子代理卡片**：时间线里的子代理块（已有）加：类型、描述、状态标签、「后台」标记、实时进度
   （「Read · 3 次工具 · 12s」）；Codex / dsh 卡片显示交给它的任务与最终结果，注明「该 CLI 不提供子代理内部步骤」。
3. **后台任务条**：输入框上方「后台任务 N」chip，展开列表；每项「停止」（Claude）或置灰说明。
4. **标签状态**：`background > 0` 且空闲时，圆点显示「后台运行中」样式（aria-label 同步）。
5. **提醒**：子代理结束 / 自发轮次结束走现有 `AgentProgressService`（看板娘气泡 + 系统通知；macOS 另有灵动岛）。
6. 无障碍：权限队列与后台任务列表可键盘操作，`Esc` 收起；状态变化用 `aria-live="polite"`。

## 6. 跨平台（macOS / Linux / Windows）

- **协议层与平台无关**：轮次归属、`stop_task`、权限回复都走 stdin NDJSON，不用信号；中止整轮仍用已有的
  `interrupt` 控制请求，拆进程用 `processTree.killProcessTree`（Windows `taskkill /T /F`，POSIX 进程组）。
- **stdin 写入**：已统一挂 `error` 监听（#46），Windows 命名管道关闭时同样不逃逸。
- **路径**：`task_notification.output_file` 等路径只展示、不拼接；显示时不假设 `/` 分隔符。
- **提醒**：系统通知用 Electron `Notification`（三平台）；灵动岛仅 macOS，其它平台没有它也不影响功能。
- **测试**：新用例只用 `.mjs` mock（经 `process.execPath` 运行），不用 `#!/bin/sh` / 无扩展名脚本、不依赖
  `sleep` 等 POSIX 命令，CI 三平台矩阵都跑；时间相关用假时钟。
- **Codex / dsh / Grok 在 Windows**：子代理事件格式与平台无关；dsh 在 Windows 用 pwsh 沙箱（不影响事件）。

## 7. 实施阶段

| 阶段   | 内容                                                                                                                                                                        | 状态                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P0-1   | Claude 轮次队列（replay + uuid）、自发轮次落盘、后台任务计数、空闲回收保护、权限经长驻 stdin 回复                                                                           | 已完成                                                       |
| P0-2   | 权限队列（主进程 `permission` 带来源 + `permission-resolved`；渲染层多项排队）                                                                                              | 已完成                                                       |
| P1     | `agent` 事件；Claude `task_*`、Codex `collab_tool_call`、dsh 子代理工具映射；工具名识别补全                                                                                 | Claude / Codex exec / dsh 已完成；Grok 待实测；Gemini 不支持 |
| P2     | 子代理卡片（状态 / 后台 / 进度 / 无内部步骤说明）、后台任务条与单独停止（Claude `stop_task`）、标签「后台运行中」、停止 / 关闭前确认；完成提醒复用自发轮次的 `tab-finished` | 已完成                                                       |
| 待实测 | Grok 子代理事件；dsh 无头在后台子代理未结束时是否提前退出                                                                                                                   | —                                                            |

## 8. 测试

- mock-claude 增加场景：前台子代理（`task_*` + 嵌套）、后台子代理（`result` 后继续输出并自发跟进）、
  两个子代理并行请求权限、自发轮次进行中用户发送。
- 解析器单测：Claude `task_*`、Codex `collab_tool_call`（用录制的真实事件做 fixture）、dsh 子代理工具。
- 渲染层：权限队列（排队、来源、超时移除）、子代理卡片、后台任务条。
