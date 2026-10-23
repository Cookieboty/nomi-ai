---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
'@nomi-ai/ui': patch
---

纠正误删：恢复 Codex 思考档 ultra/「极限」。API 有 max；Codex CLI/Desktop 另有 client 档 ultra（推理侧映射 max + multi-agent）。normalizeEfforts 保留 CLI 返回的 ultra；传 CLI 时原样传 model_reasoning_effort="ultra"。取代错误的 v120-drop-ultra-reasoning。
