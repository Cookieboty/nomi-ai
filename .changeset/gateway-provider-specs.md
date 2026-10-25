---
'@nomi-ai/gateway': patch
---

第三方供应商的差异改为「供应商规格」统一管理：DeepSeek、智谱、Kimi、MiniMax 的已知差异（推理回传、工具数上限、固定参数）按域名也能识别，手动添加、没用预设的也生效；Amux 流里伪装成正文的保活不再被当成「已经开始输出」，开头就报错时会换下一个 Key / 供应商重试，保活改成给编程助手的心跳（Claude Code 收到 ping，其它协议收到 SSE 注释），长时间思考时不会被判定为空闲断开；Amux 的 `response.metadata` 私有事件直接丢掉。
