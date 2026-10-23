---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

修复输入栏上下文环与 /context 的用量：改为取这一轮最后一次模型请求的输入 + 输出（Claude Code、Codex、Grok、Gemini、dsh 与 Nomi 各按实测口径），不再把整轮累计当成当前上下文；窗口大小优先用 CLI 上报值（如 Claude 1M）。dsh 现在也会显示用量。
