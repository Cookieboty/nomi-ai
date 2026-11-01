---
'@nomi-ai/ai-chat': patch
'@nomi-ai/cli-sdk': patch
---

fix(context): Codex 压缩上下文后，回合结束前没有新的占用上报时，上下文环不再把压缩前的旧值当作当前占用（也不会在重开会话后恢复），改为估算，直到下一次真实上报。Node 与 Go 版一致（#217）。
