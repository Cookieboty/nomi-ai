---
'@nomi-ai/ai-chat': patch
---

fix(conversation): 长对话滚动不再跳。分页窗口与轮次分组拆成纯工具（`Conversation/windowing.ts`），窗口上界在单会话内只扩不缩；新消息到达或大段 trace 收起导致内容高度骤变时，区分「用户主动滚动」与「被动 clamp」，不把已上滑读历史的用户吸回底部，也不误断贴底跟随；顶部改用哨兵元素无感预加载更早历史。已完成轮次的 `content-visibility` 收进 `@supports (overflow-anchor: auto)`，避开 WKWebView 无滚动锚定时的 400px 估算高度跳动。另新增沿会话边缘的轮次快捷导航条（悬停看该轮助手摘要，点击平滑跳转）。/ Long conversations no longer jump while scrolling: the paging window and turn grouping move into a pure helper module, the window only ever grows within a session, height collapses (a new message, a large trace folding up) no longer drag the reader back to the bottom or break follow mode, and earlier history preloads through a top sentinel. Completed turns only use `content-visibility` where scroll anchoring exists, avoiding the 400px estimate jump in WKWebView. A turn quick-nav rail is added alongside the conversation (hover for that turn's summary, click to jump).
