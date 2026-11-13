# 子任务对话与主对话对齐

状态：侧栏方案。主列留在来源对话，子任务在旁边打开，两边同时实时更新；三类子任务都能在侧栏里接着说话。

## 建议

子任务必须留在右侧栏。主列一切走，就看不到父对话里的进度，也无法一边看子任务一边接着和 Nomi 说。

侧栏不再做一套缩小的输入框。它是主对话同一套管线的第二个实例，按会话 id 绑定，而不是认「当前标签」：

- 委派出去的编程助手（Claude Code、Codex、ACP）已经是 harness 标签。侧栏把 `CliConversation` 和 `MessageInput` 绑到这个 `tabId`：发送走 `sendToTab`，权限走 `replyPermissionFor`，停止走 `cancelRun`，待发列表走这份标签自己的队列。模型、权限模式、提问卡、附件、斜杠命令、转录详细程度都跟着这个 id。主列的当前标签不动，所以父对话的输入栏和流式输出照常。
- 进程内子代理（`Task` / `Agent`、`spawn_agent`）没有自己的 harness 标签。步骤和它自己说的话挂在父转录里、`parentId` 指向这次调用。侧栏用同一个 `ConversationView` 画出任务说明、它的正文和步骤，用同一个 `MessageInput` 接着说话（见下面「追问语义」）。
- `delegate_to_nomi` 是后台 Nomi 任务，不是编程助手标签。侧栏用 `tasks.trace`（每次执行一轮）画成会话，正在跑的这次由 `tasks.live` 事件实时推送；输入栏插话走 `tasks.steer`，追问走 `tasks.followUp`，停止走 `tasks.cancel`。

不把子任务嵌进父消息列表当线程：滚动和提问卡会和父对话抢同一条时间线。也不把委派标签 `activate` 成主列：那样父对话就看不见了。

## 为什么以前会分叉

委派在 Go 里就是 harness 标签，消息、插话、权限和停止与用户自己开的标签相同。视图却只把「当前标签」交给 `CliConversation` / `MessageInput` / 提问卡 / 待发队列。侧栏打不到这条链路，就自己做了两行文本框和另一份 `subagentQueue`。

这一阶段把上述操作改成带 `tabId` 的函数，并让非当前标签的消息缓存可以被侧栏钉住（`useHarnessTabMessages`）。主列仍只订阅当前标签，不会因为侧栏里的流式输出整页重渲染。

## 能力

| 交互                       | 主对话             | 委派标签侧栏                 | 进程内子代理                                      | 后台 Nomi                                         |
| -------------------------- | ------------------ | ---------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| 消息 / 工具渲染            | `ConversationView` | 同一个 `CliConversation`     | 同一个 `ConversationView`（父转录里的正文与步骤） | 同一个 `ConversationView`（`tasks.trace` + 实时） |
| 实时更新                   | 流式事件           | 同一套标签事件               | 父标签的实时事件（`agent-text` / 子步骤）         | `tasks.live` 事件（正文增量、思考、工具、插话）   |
| 输入栏                     | `MessageInput`     | 同一个，绑这个标签           | 同一个，经来源标签转给子代理                      | 同一个：插话 / 排队 / 追问                        |
| 插入 / 排队 / 停止         | 有                 | 有，按标签 id                | 用来源标签的队列；停止见下                        | 有：`tasks.steer` / 本地队列 / `tasks.cancel`     |
| 权限 / 计划审批 / 沙箱     | 有                 | 有（持续任务仍先经任务回应） | 仍出现在父会话                                    | 任务自己的等待，不在这张卡                        |
| 提问卡                     | 有                 | 有，按 `tabId`               | 不单独有                                          | 不单独有                                          |
| 模型 / 思考深度 / 权限模式 | 有                 | 有，`endpointTab`            | 不适用（跟来源标签）                              | 不适用（跟对话模型）                              |
| 附件                       | 有                 | 有                           | 有（跟来源标签的看图能力）                        | 只能发文字                                        |
| 斜杠命令 / 设置 / 插件按钮 | 有                 | 有，打开主窗口的面板         | 输入栏自带的界面命令，打开主窗口的面板            | 同左（没有插件按钮）                              |
| 结果回到父对话             | 不适用             | 有，内核 follow-up 未改      | 结果留在父转录                                    | 每次执行（包括追问）做完都写回来源对话            |
| 主列是否被切走             | —                  | 否                           | 否                                                | 否                                                |

## 会话模型

```text
SubagentTarget =
  | { kind: 'harness', tabId }
  | { kind: 'nested', callId, parentTabId }
  | { kind: 'nomi-task', taskId }
```

- `harness`：现成的标签消息、实时事件和队列。空闲时用户接着说不算接手；委派还在跑时发送仍由内核标 `takenOver`。
- `nested`：不新建存储。`callId` 在父消息的 trace 里，子步骤的 `parentId` 等于它。子代理自己说的话是新的轨迹事件 `agent-text`（`text`、`parentId`），Claude Code 带 `parent_tool_use_id` 的助手消息解析成它，不再并进主回复的正文；它和 tool / thinking / interject 一样进 `BuildTrace`（同一个子代理连续几段合成一段），落盘后重开也在。主时间线（`reduceTrace`）跳过它，侧栏把它拼成子代理的正文，子步骤的 `textAt` 改成在这段正文里的位置。`parentTabId` 为空表示父转录是 Nomi 对话本身。
- `nomi-task`：任务 id。`tasks.trace` 返回 `attempts`（每次执行：`cause`、追问原话 `note`、状态、轨迹行）和 `live`（正在跑那次写到一半的正文、思考、进行中的工具）。轨迹行现在带 `id`、`input`、`startedAt`、`textAt`，插话记成 `user` 行。会话 = 第一条用户消息是任务目标，每次 `followup` 执行前插一条用户消息（原话），每次执行一条助手消息；正在跑的那次由 `live` 画。

### 实时更新

- 后台 Nomi：执行者给这次执行一个固定的请求 id（`task-<attemptId>`），流里的 `delta` / `reasoning` / `tool_call.delta` / `tool_call.result` 同时写进内存快照并经 `tasks.live` 事件推给界面（`{ id, attemptId, event }`）。侧栏打开时拿一次 `tasks.trace` 快照，之后按事件累积；一步做完（工具结束）、执行结束或 `tasks.changed` 时重新对一次快照（合并 120ms 内的多次通知），快照覆盖累积的增量，所以不会越积越偏。不再定时轮询。
- 进程内子代理：Claude Code 的子代理消息是整条到达的（CLI 不给子代理发 token 级增量），所以侧栏按「一条一条」实时出现；工具步骤和以前一样随父标签的实时事件出现。

### 追问语义

后台 Nomi（`nomi-task`）：

- 正在跑时按 Enter：`tasks.steer` 把这句话交给这次执行的工具循环（和主对话的插话同一条路：`client.chat.Steer`），下一步并进上下文，轨迹里记一行 `user`，侧栏里显示成插话。这一步已经不收插入消息（模型在写结论、或刚好结束）时返回 false，这句话改进待发列表。
- 正在跑时按 Ctrl/⌘+Enter：进待发列表。这次执行结束（做完、失败或被停下）后，列表里的消息合成一条，用 `tasks.followUp` 发出。
- 空闲时发送：`tasks.followUp`。状态机新事件 `follow_up`：只在 idle / done / failed / cancelled 时接受（运行中返回 busy，界面把这句话放进待发列表），带着 `PendingRun{Cause: "followup", Note: 原话}` 重新排队，沿用上一次执行的触发事件批。执行时提示词说明「这是同一件事的追问」，带上用户原话和上一次的结论（`Previous.Result.Summary`），要求在已有成果上改、不重复对外动作。只支持 Nomi 执行者。
- 停止：`tasks.cancel` 取消这次执行；Esc（待发列表非空）= 停下这次并马上把列表作为追问发出。
- 结果：每次执行（包括追问）做完照常写回来源对话，和第一次一样。

进程内子代理（`nested`）：CLI 没有对外的「给某个子代理发消息」接口，所以消息经来源标签发给主代理，由它转交：

- 侧栏发送的正文包一层说明（`ui.session-workspace.subagent-envelope`）：点名子代理（名字和 id；Codex 是 agent thread id，Claude 是调用 id / 后台任务 id），请主代理用自己给子代理发消息的工具（Codex 的 `send_input` / `resume_agent`、Claude Code 的 `SendMessage` 等）转给它；子代理已经结束就在它的结果上接着做。
- 发送、插话、排队都走来源标签的 `sendToTab`，和主列在这个标签里发送完全一样（来源标签在跑就插话或排队，空闲就新开一轮）。待发列表只显示从侧栏发出的那几条，显示的是用户原话。
- 停止：后台子代理用 `stopAgent` 单独停；前台子代理是来源这一轮的一部分，停它就是停这一轮（`cancelRun`）。
- 父转录是 Nomi 对话（`parentTabId` 为空）时没有来源标签可转，输入栏不显示，提示回主对话说。

### 主窗口面板

侧栏里 `MessageInput` 的设置、模型、插件、扩展、知识 · 记忆、桌面能力、本地模型这些按钮和输入栏自带的界面命令（`/settings`、`/desktop` …），以及斜杠命令里的 `onOpenPlugins` / `onOpenProviders` / `onOpenSettings`，都接到主窗口的同一组面板（`SubagentPaneActions`，由 `App` 经 `SideColumn` 传入，和主列输入栏是同一组回调）。编程助手的设置会先切到这个子任务的 CLI 再打开。`/new` 在侧栏里不开新标签，免得主列被切走。

## 还没做

- 后台 Nomi 的追问只能发文字（`tasks.followUp` 没有图片入参）。
- Claude Code 子代理的正文是整条到达的，没有逐字流式；Codex 子代理是独立线程，它内部的正文和步骤仍只有 `spawn_agent` / `wait` 的结果。
- 进程内子代理的追问靠主代理转交，是否真的转给了那个子代理取决于 CLI 有没有对应工具；没有时主代理会在子代理的结果上自己接着做。
- `subagentQueue` 不再接到界面上。模块和单测还留着，确认标签队列覆盖同一组竞态后再删。
