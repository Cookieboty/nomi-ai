---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
'@nomi-ai/i18n': patch
---

编程助手可以同时安装 / 更新：装 Claude Code 时不再禁用 Codex 等其他助手的按钮。只有往同一位置执行的 `npm install -g` 会排队（并发会互相覆盖），排队时日志里会提示「等另一个 npm 安装完成后继续」。
