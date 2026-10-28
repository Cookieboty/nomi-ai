---
'@nomi-ai/host-electron': patch
'@nomi-ai/renderer': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/types': patch
---

feat(tts): Edge 实时朗读：没有预录片段的诺米台词改用微软 Edge 在线朗读（默认音色晓伊 `zh-CN-XiaoyiNeural`、语速 -5%），新安装默认开启。设置里可换中文音色（在线列表，取不到时用内置几个）、调语速、试听；长文本去掉 Markdown / 代码后按句流式播放，可打断。需要联网；这不是微软公开的官方接口，可能失效，许可属灰色地带。没联网、超时、被拒或协议变化时静默只显示文字，连续失败后设置里显示白话提示。客户端为项目自写（基于已有的 `ws`），不新增依赖。
