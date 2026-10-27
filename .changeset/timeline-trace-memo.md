---
'@nomi-ai/ai-chat': patch
---

流式输出时工具时间线只在轨迹变化时重建，纯文本帧只做文本切片；同一份轨迹只归约一次，ToolTimeline 加 memo。
