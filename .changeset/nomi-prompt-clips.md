---
'@nomi-ai/renderer': patch
'@nomi-ai/electron': patch
'@nomi-ai/types': patch
---

feat(voice): 诺米中文提示语改为内置晓伊预录语音（96 段，约 1.6 MB）。播放顺序：预录片段 → 实时朗读 → 静音；仅在诺米模型、中文界面、未静音且开启「提示语音」时播放。带变量的台词气泡显示完整文字、语音念固定句。新增 IPC `tts:prompt-voice`。片段由微软 Edge 在线 Neural 服务生成，正式发布前需用 Azure 订阅重新生成。
