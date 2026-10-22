---
'@nomi-ai/gateway': patch
---

修复 Responses 入口在上游用 CRLF 换行时流式输出被攒到整轮结束（#94）：补全层按 LF / CRLF 空行分帧并原样保留换行；上游中途出错时先写出已收到的完整事件。
