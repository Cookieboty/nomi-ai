---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

对话区的供应商按钮只列当前编程助手的官方账号（#69）：从 Codex 标签切到 dsh / Claude 等标签后，上一个后端的账号不再残留在下拉里，也不能借过时的选项切换另一个 CLI 的全局登录；切换账号时同时带上所属后端，主进程核对不一致就拒绝。
