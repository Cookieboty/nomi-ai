---
'@nomi-ai/ai-runtime': minor
'@nomi-ai/gateway': minor
---

DeepSeek、智谱 GLM、Kimi、通义千问（百炼）、MiniMax 的预设补全了 Anthropic、Chat、Responses 各协议的官方地址和主力模型的上下文、输出上限、推理 / 视觉 / 工具调用能力（按官方文档核对，2026-10-21），新增 GLM Coding Plan 和百炼 Coding Plan 预设。添加这些供应商时只检测它们官方提供的协议，模型参数一起保存；网关按厂商要求处理固定参数和多轮推理内容（如 Kimi 的固定 temperature、DeepSeek 工具调用时必须带回推理内容）。
