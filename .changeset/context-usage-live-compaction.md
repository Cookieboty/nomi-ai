---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

fix(context): 上下文环在一轮进行中实时更新，自动压缩、重启后都不再停在压缩前的旧值。
Claude Code 标签直接读 CLI 自己的会话记录（最近一次请求的真实占用与模型名），分项按最后一次压缩之后的内容计算、加起来等于总量，系统提示按压缩后第一次请求的真实占用定基线；
Codex / Gemini / Grok / dsh 每次模型请求实时上报当前占用（Codex / Gemini 同时带模型窗口）；识别压缩摘要，压缩前的用量作废；中断 / 失败的一轮也记下最后的占用；Opus 5.x 窗口按 1M 计。
