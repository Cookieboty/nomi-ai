---
'@nomi-ai/ai-chat': patch
---

feat(chat): 后台委派结束时不再往会话流里堆气泡，改成底部短暂轻提示。被停止的委派只弹「某某的委派任务已停止」（连续停止自动聚合成「N 个委派任务已停止」），不写消息、不落盘、也不再 steer 给主模型；已完成 / 失败且会话里已有原位委派卡片（`delegate_to_cli` 工具调用）的，结果以静默上下文写入（内存与新开一轮时模型仍读得到），列表里不渲染成气泡。`/agent` 直接派出、followUp 续聊或后台生成了图片时结果照旧可见，产出不丢。顺手修掉后台结果消息插在尾部导致主回复提前定稿（流式尾被误判）的问题。/ Background delegations no longer pile up as chat bubbles when they finish: a cancelled one now only raises a brief toast (consecutive cancellations merge into "N delegations stopped") without writing a message or steering the model, and a finished/failed one whose in-place delegation card is already on screen is stored as silent context — still visible to the model next turn, but not rendered as a bubble. Results stay visible when they must be (`/agent`, follow-up threads, generated images), and background messages landing at the tail no longer make a still-streaming reply settle early.
