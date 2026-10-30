---
'@nomi-ai/core': minor
'@nomi-ai/contract': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/i18n': patch
'@nomi-ai/ai-runtime': minor
'@nomi-ai/ai-sdk': patch
---

Nomi 对话的上下文按模型优化：每轮带多少历史改为按实际路由到的模型的上下文窗口计算（为回答预留输出空间），不再固定 8K token；用到输入预算的 95% 时，发送前自动把较早的对话压缩成摘要（同其它 CLI），对话里显示一条可展开的「已压缩」分隔线；`/compact` 可随时手动压缩。新增契约查询 `gateway.nomiContext`。Node 版与 Go 版一致。

工具循环每轮的步数上限从 5 步放宽到 20 步，读写文件等多步任务不再中途停下。
