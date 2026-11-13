# 子任务对话与主对话对齐

状态：侧栏方案。主列留在来源对话，子任务在旁边打开，两边同时实时更新；三类子任务都能在侧栏里接着说话。

## 建议

子任务必须留在右侧栏。主列一切走，就看不到父对话里的进度，也无法一边看子任务一边接着和 Nomi 说。

侧栏不再做一套缩小的输入框。它是主对话同一套管线的第二个实例，按会话 id 绑定，而不是认「当前标签」：

- 委派出去的编程助手（Claude Code、Codex、ACP）已经是 harness 标签。侧栏把 `CliConversation` 和 `MessageInput` 绑到这个 `tabId`：发送走 `sendToTab`，权限走 `replyPermissionFor`，停止走 `cancelRun`，待发列表走这份标签自己的队列。模型、权限模式、提问卡、附件、斜杠命令、转录详细程度都跟着这个 id。主列的当前标签不动，所以父对话的输入栏和流式输出照常。
- 进程内子代理（`Task` / `Agent`、`spawn_agent`）没有自己的 harness 标签。步骤、思考和它自己说的话挂在父转录里、`parentId` 指向这次调用（或子代理自己的 id）。侧栏用同一个 `ConversationView` 画出任务说明、它的正文和步骤，用同一个 `MessageInput` 直接对这个子代理说话（`harness.messageAgent`，见下面「直接对子代理说话」）。
- `delegate_to_nomi` 是后台 Nomi 任务，不是编程助手标签。侧栏用 `tasks.trace`（每次执行一轮）画成会话，正在跑的这次由 `tasks.live` 事件实时推送；输入栏插话走 `tasks.steer`，追问走 `tasks.followUp`，停止走 `tasks.cancel`。

不把子任务嵌进父消息列表当线程：滚动和提问卡会和父对话抢同一条时间线。也不把委派标签 `activate` 成主列：那样父对话就看不见了。

## 为什么以前会分叉

委派在 Go 里就是 harness 标签，消息、插话、权限和停止与用户自己开的标签相同。视图却只把「当前标签」交给 `CliConversation` / `MessageInput` / 提问卡 / 待发队列。侧栏打不到这条链路，就自己做了两行文本框和另一份待发队列（`subagentQueue`，现已删除：标签队列和侧栏自己的直接发送队列覆盖了它）。

这一阶段把上述操作改成带 `tabId` 的函数，并让非当前标签的消息缓存可以被侧栏钉住（`useHarnessTabMessages`）。主列仍只订阅当前标签，不会因为侧栏里的流式输出整页重渲染。

## 能力

| 交互                       | 主对话             | 委派标签侧栏                 | 进程内子代理                                        | 后台 Nomi                                         |
| -------------------------- | ------------------ | ---------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| 消息 / 工具渲染            | `ConversationView` | 同一个 `CliConversation`     | 同一个 `ConversationView`（父转录里的正文与步骤）   | 同一个 `ConversationView`（`tasks.trace` + 实时） |
| 实时更新                   | 流式事件           | 同一套标签事件               | 父标签的实时事件（正文、思考、子步骤；Codex 逐字）  | `tasks.live` 事件（正文增量、思考、工具、插话）   |
| 输入栏                     | `MessageInput`     | 同一个，绑这个标签           | 同一个，直接发给子代理本身（不支持的 CLI 经主代理） | 同一个：插话 / 排队 / 追问                        |
| 插入 / 排队 / 停止         | 有                 | 有，按标签 id                | 有：插进子代理这一步 / 侧栏队列 / 单独停它          | 有：`tasks.steer` / 本地队列 / `tasks.cancel`     |
| 权限 / 计划审批 / 沙箱     | 有                 | 有（持续任务仍先经任务回应） | 仍出现在父会话                                      | 任务自己的等待，不在这张卡                        |
| 提问卡                     | 有                 | 有，按 `tabId`               | 不单独有                                            | 不单独有                                          |
| 模型 / 思考深度 / 权限模式 | 有                 | 有，`endpointTab`            | 不适用（跟来源标签）                                | 不适用（跟对话模型）                              |
| 附件                       | 有                 | 有                           | 有（跟来源标签的看图能力）                          | 有（图片，最多 8 张）                             |
| 斜杠命令 / 设置 / 插件按钮 | 有                 | 有，打开主窗口的面板         | 输入栏自带的界面命令，打开主窗口的面板              | 同左（没有插件按钮）                              |
| 结果回到父对话             | 不适用             | 有，内核 follow-up 未改      | Codex 留在父转录；Claude 接续会话不自动回传         | 每次执行（包括追问）做完都写回来源对话            |
| 主列是否被切走             | —                  | 否                           | 否                                                  | 否                                                |

## 会话模型

```text
SubagentTarget =
  | { kind: 'harness', tabId }
  | { kind: 'nested', callId, parentTabId }
  | { kind: 'nomi-task', taskId }
```

- `harness`：现成的标签消息、实时事件和队列。空闲时用户接着说不算接手；委派还在跑时发送仍由内核标 `takenOver`。
- `nested`：不新建存储（Claude Code 接续会话例外，见下）。`callId` 在父消息的 trace 里，子步骤的 `parentId` 等于它（Codex 子线程在派出调用登记前的事件用线程 id，侧栏两者都认）。子代理自己说的话是新的轨迹事件 `agent-text`（`text`、`parentId`），Claude Code 带 `parent_tool_use_id` 的助手消息解析成它，不再并进主回复的正文；它和 tool / thinking / interject 一样进 `BuildTrace`（同一个子代理连续几段合成一段），落盘后重开也在。主时间线（`reduceTrace`）跳过它，侧栏把它拼成子代理的正文，子步骤的 `textAt` 改成在这段正文里的位置。`parentTabId` 为空表示父转录是 Nomi 对话本身。
- `nomi-task`：任务 id。`tasks.trace` 返回 `attempts`（每次执行：`cause`、追问原话 `note`、状态、轨迹行）和 `live`（正在跑那次写到一半的正文、思考、进行中的工具）。轨迹行现在带 `id`、`input`、`startedAt`、`textAt`，插话记成 `user` 行。会话 = 第一条用户消息是任务目标，每次 `followup` 执行前插一条用户消息（原话），每次执行一条助手消息；正在跑的那次由 `live` 画。

### 实时更新

- 后台 Nomi：执行者给这次执行一个固定的请求 id（`task-<attemptId>`），流里的 `delta` / `reasoning` / `tool_call.delta` / `tool_call.result` 同时写进内存快照并经 `tasks.live` 事件推给界面（`{ id, attemptId, event }`）。侧栏打开时拿一次 `tasks.trace` 快照，之后按事件累积；一步做完（工具结束）、执行结束或 `tasks.changed` 时重新对一次快照（合并 120ms 内的多次通知），快照覆盖累积的增量，所以不会越积越偏。不再定时轮询。
- Claude Code 子代理：启动 CLI 后先发 `initialize` 控制请求并带 `forwardSubagentText: true`（官方 SDK 同名选项），CLI 才会把子代理自己的助手消息（正文、思考）写到 stdout；之前不开这个选项时只有工具步骤。子代理的消息是整条到达的：CLI 的 token 级 `stream_event` 只发主代理的（实测子代理的 `parent_tool_use_id` 恒为空），所以子代理正文没法逐字流式，按「一条一条」实时出现。子代理的思考带 `parentId`，主时间线不画，侧栏里显示。
- Codex 子代理：app-server 把 `spawn_agent` 派出的子线程自动挂到同一条连接上，子线程的通知带着自己的 `threadId`。驱动按 `thread/started`（`parentThreadId` 是主线程或已知子线程）和 `collabAgentToolCall.receiverThreadIds` 登记子线程，把它的通知转成带 `parentId` 的事件：`turn/started` / `turn/completed` → `agent` 开始 / 结束，`item/agentMessage/delta` → `agent-text-delta`（逐字增量，只实时推送、不落盘），完整的 `agentMessage` → `agent-text`，命令、改文件、MCP 调用等 → 子步骤。以前这些通知被主线程过滤掉了，侧栏只看得到 `spawn_agent` / `wait` 的结果。
- 来源标签这一轮在跑时，子代理事件并进这一轮（和以前一样落进这一轮的轨迹）；来源标签空闲时（用户直接对子代理说话后它接着跑），事件带 `detached: true` 推给界面，进单独的子代理实时状态（`useHarnessDetached`，标签空闲 / 定稿时不清），轨迹事件直接追加进派出它的那条助手消息并落盘，再以 `harness.tabMessage { updated: true }` 广播，界面按 id 替换这条消息、不动主列的实时进度。

### 直接对子代理说话

侧栏输入栏里的话直接交给这个子代理本身（`harness.messageAgent { id, callId, agentId, text, images, mode }`），不经主代理转述。用户的话记成轨迹事件 `agent-input`（`text`、`parentId`、附图缩略图），侧栏把每条 `agent-input` 画成子代理会话里的一轮（用户消息 + 它接下来的回复）。各家 CLI 的实际能力：

| CLI                                                     | 直接通道                                                                                              | 在跑时                                                                                                       | 结束后                                                                                                                                                                                                                                                                                          | 结果去向                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Codex（app-server）                                     | 有：子线程本身                                                                                        | `turn/steer { threadId: 子线程, expectedTurnId }` 插进它这一轮（只带文字；带图时等这一轮结束后作为新一轮发） | `turn/start { threadId: 子线程 }` 在它自己的线程上开新一轮；线程已卸载时先 `thread/resume`                                                                                                                                                                                                      | 子线程的上下文里；事件写进父转录，主代理下次 `wait` / 读它时能看到 |
| Codex multi-agent v2 子代理                             | app-server 拒收外部直接输入（`direct app-server input is not allowed for multi-agent v2 sub-agents`） | 同右                                                                                                         | `thread/fork` 出它的线程（带着它的全部上下文），之后对它说的话都发给这个副本；对应关系记在标签上（`agentForks`），重启后仍发给同一个副本                                                                                                                                                        | 副本里，不回到原来的子代理 / 主代理                                |
| Claude Code                                             | 没有：headless 模式下没有对外的「给某个子代理发消息」接口（`SendMessage` 只给模型用）                 | 先排在侧栏里（`reason: running`），等它结束（且来源这一轮结束）后再发                                        | 把它自己的会话记录 `<配置目录>/projects/<项目>/<会话 id>/subagents/**/agent-<agentId>.jsonl` 复制成一个独立会话（每行 `sessionId` 换成新 id、`isSidechain` 置 false、去掉 `agentId`），开一个关联标签（`subagentOf { tabId, callId, agentId }`）`--resume` 新会话接着说。之后的话都发给这个标签 | 关联标签里，不自动交回主代理（提示里说明）                         |
| 其余 CLI（Gemini、Kimi 等 ACP 系，Grok、dsh、外部插件） | 没有：没有可寻址的子代理（ACP 没有子代理概念；Grok、dsh 每轮一个进程、不报子代理会话 id）             | 返回 `unsupported`，改经主代理转达                                                                           | 同左                                                                                                                                                                                                                                                                                            | 主代理                                                             |

- 子代理的 id：Codex 是子线程 id（`spawn_agent` 调用输入里的 `agents`、`agent` 事件的 id）；Claude Code 是 `agentId`（`task_started` 的 `task_id`，以及 `Agent` 工具结果末尾的 `agentId: …`）。
- 在跑、这一步不收（`busy`），或 Claude 子代理还在跑（`running`）：这句话排在侧栏自己的待发列表里，子代理这一步结束后合成一条再直接发给它；Ctrl/⌘+Enter 一律先排队。
- 关联标签（Claude）出现后，侧栏把它的消息接在子代理会话后面，实时进度、提问卡、待发列表、停止都按这个标签走。
- 停止：Claude 关联标签在跑就停它；Codex 子线程（包括直接对话后它接着跑的那一轮）用 `stopAgent` 打断它自己的这一轮（`turn/interrupt { threadId: 子线程 }`）；Claude 后台子代理用 `stop_task`；前台子代理是来源这一轮的一部分，停它就是停这一轮。
- 不支持直接通道时（`unsupported`）：退回原来的做法，正文包一层说明（`ui.session-workspace.subagent-envelope`）经来源标签的 `sendToTab` 发给主代理，由它用自己的工具转给这个子代理；侧栏提示改成「经主代理转达」。
- 父转录是 Nomi 对话（`parentTabId` 为空）时没有来源标签，输入栏不显示，提示回主对话说。

### 追问语义（后台 Nomi）

- 正在跑时按 Enter：`tasks.steer` 把这句话交给这次执行的工具循环（和主对话的插话同一条路：`client.chat.Steer`），下一步并进上下文，轨迹里记一行 `user`，侧栏里显示成插话。这一步已经不收插入消息（模型在写结论、或刚好结束）时返回 false，这句话改进待发列表。
- 正在跑时按 Ctrl/⌘+Enter：进待发列表。这次执行结束（做完、失败或被停下）后，列表里的消息合成一条，用 `tasks.followUp` 发出。
- 空闲时发送：`tasks.followUp { id, text, images? }`。状态机事件 `follow_up`：只在 idle / done / failed / cancelled 时接受（运行中返回 busy，界面把这句话放进待发列表），带着 `PendingRun{Cause: "followup", Note: 原话, Images: 图片文件}` 重新排队，沿用上一次执行的触发事件批。执行时提示词说明「这是同一件事的追问」，带上用户原话和上一次的结论（`Previous.Result.Summary`），要求在已有成果上改、不重复对外动作。只支持 Nomi 执行者。
- 图片：追问可以带图片（最多 8 张，可以只发图片）。图片写到 `<数据目录>/attachments/<任务 id>/`，路径记在这次执行的 `cause.images` 里，执行时读回来作为图片交给模型（和目标那条用户消息一起）。运行中带图片的消息和主对话一样不进插话 / 排队，等这次结束后再发。
- 停止：`tasks.cancel` 取消这次执行；Esc（待发列表非空）= 停下这次并马上把列表作为追问发出。
- 结果：每次执行（包括追问）做完照常写回来源对话，和第一次一样。

### 主窗口面板

侧栏里 `MessageInput` 的设置、模型、插件、扩展、知识 · 记忆、桌面能力、本地模型这些按钮和输入栏自带的界面命令（`/settings`、`/desktop` …），以及斜杠命令里的 `onOpenPlugins` / `onOpenProviders` / `onOpenSettings`，都接到主窗口的同一组面板（`SubagentPaneActions`，由 `App` 经 `SideColumn` 传入，和主列输入栏是同一组回调）。编程助手的设置会先切到这个子任务的 CLI 再打开。`/new` 在侧栏里不开新标签，免得主列被切走。

## 做不到的

- Claude Code 子代理的正文没法逐字流式：CLI 只给主代理发 token 级 `stream_event`，子代理的消息只能整条拿到。
- Claude Code 子代理在跑时没法直接插话：headless 模式没有对外接口，只能等它结束后接着它自己的会话（关联标签）；接续会话的结果不会自动交回主代理。
- Codex multi-agent v2 子代理只听它的主代理：直接对话发生在它的副本（fork）上，原来的子代理和主代理看不到。
- 其余 CLI（ACP 系、Grok、dsh、外部插件）没有可寻址的子代理，只能经主代理转达。
