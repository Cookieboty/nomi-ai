# 运行中追加消息：插入与排队（设计稿 + 实现记录）

> 状态：**Claude Code、Codex、Grok、Nomi 对话已实现（Node 版与 Go 版）；Gemini 只能排队；dsh 待改常驻会话后支持插入**。
> 查证日期 2026-11-04：Claude Code 2.1.318、Codex CLI 0.164.0、Grok 1.0.70、Gemini CLI 0.65.0、dsh 0.2.1-rc.2（macOS）。
> 代码：视图 `packages/ai-chat/src/utils/pendingSends.ts`、`hooks/useSendQueue.ts`、`contexts/HarnessTabsContext.tsx`、
> `components/PendingDock`；内核 `cli-sdk/src/drivers/*`（`steer`）、`core/src/cli/harness/Orchestrator.ts`（`steerTab`）、
> `ai-runtime/src/ai-sdk/AiSdkLlmProvider.ts`（`steer` + `prepareStep`）。

## 1. 要什么

一轮还在跑时，用户可以一直发消息，不会终止这一轮：

| 操作                          | 效果                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| **Enter**                     | 插入（steer）：进待发列表，在下一个安全点交给这一轮，模型在下一个工具 / 模型步骤看到它 |
| **Ctrl / ⌘+Enter**            | 排队（queue）：进待发列表，这一轮结束后作为新的一轮发出                                |
| **Esc**（输入框里、列表非空） | 停止这一轮，把待发列表合成一条马上发出                                                 |
| 待发列表上的按钮              | **撤回修改**（文字退回输入框，从列表移除）、**删除**                                   |

空闲时 Enter / Ctrl+Enter 都是普通发送。待发列表显示在输入框正上方，每条标「插入」或「排队」。

## 2. 各 CLI 的能力（实测）

| 后端        | 接法                         | 中途插入                                                                                                                                                        |
| ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | stream-json 常驻进程         | 一轮进行中再写一条 `user` 行：CLI 放进自己的队列，在下一个工具结果处并进这一轮（只出一个 `result`），包成「The user sent a new message while you were working」 |
| Codex       | app-server                   | `turn/steer {threadId, expectedTurnId, input}`，应答 `{turnId}`；模型取走时发出 `userMessage` 条目                                                              |
| Grok        | ACP                          | 扩展方法 `_x.ai/interject {sessionId, text}`，应答 `{status:"queued"}`；取走时发 `x.ai/session/interjection`                                                    |
| Gemini      | ACP                          | **不支持**：新的 `session/prompt` 会中止当前这一轮（`pendingPrompt.abort()`）→ 只能排队                                                                         |
| dsh         | headless，每轮一个进程       | agent loop 有 `steer`（下一步）/ `followup`（下一轮），但只在常驻会话 API 里提供 → 现在只能排队                                                                 |
| Nomi 对话   | AI SDK `streamText` 工具循环 | 自己实现：`prepareStep` 在每一步开始前把收到的插入消息放到当时的位置，之后每一步都带着                                                                          |

能力位：`cli-catalog` 清单 `capabilities.steer`（claude / codex / grok 为 true）。不支持的后端，Enter 也按排队处理。

注意：Claude 中途消息是作为工具结果的附带内容送给模型的。实测 haiku 会把它当成提示词注入而忽略，sonnet 正常照做。

## 3. 交付时机：为什么先放在列表里

CLI 一收下就撤不回来了，所以插入消息先放在待发列表里，到**安全点**才交出去：

1. **下一个工具开始时**（实时事件里的 `tool start`）：CLI 会在这个工具的结果处取走它；
2. **入列时正好有工具在跑**：马上交出去，在这个工具的结果处取走。

在这之前（模型还在想 / 写正文）都可以撤回修改或删除。交出去后它从列表消失，在这一轮的回复中间显示「你插入了：…」
（轨迹事件 `{type:'interject', text, at, textAt}`，随消息落盘）。

交不出去（后端不支持、进程是 exec 退路、这一轮刚好结束、CLI 拒绝）就**改为排队**，放回列表最前。
这一轮结束时还没交出去的插入消息，也按排队的顺序作为下一轮发出。多条同时交付时合成一条（空一行分隔）。

## 4. 契约

| 过程               | 入参              | 出参      | 说明                                            |
| ------------------ | ----------------- | --------- | ----------------------------------------------- |
| `harness.tabSteer` | `{ id, text }`    | `boolean` | 编程助手标签；没有进行中的轮次 / 不支持时 false |
| `ai.chat.steer`    | `{ reqId, text }` | `boolean` | Nomi 对话；请求已结束 / 没有工具循环时 false    |

内核 `steerTab` 成功后在这一轮的 `events` 里记一条 `interject`（经 `foldAssistantEvent` 带上 `textAt`），实时广播并落盘；
Nomi 对话的消息由视图保存，插入记录由视图写进这一轮的轨迹。之后的轮次发历史时，插入的消息作为一条用户消息放在那条回复前面。

## 5. 以后

- dsh：改成常驻会话（会话 API 的 `prompt {mode:'steer'|'queue'}`），之后打开 `steer` 能力位；
- Gemini：等 CLI 提供中途插入。
