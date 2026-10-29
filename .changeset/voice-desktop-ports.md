---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

refactor(voice/desktop): 看板娘临时召回、确认答复的来源校验、语音会话随发起窗口释放改走宿主端口 `windows`；看板娘把识别结果投递到刚打开的对话窗口时不再等页面加载 500ms，对话窗口挂载后经 `voice.takePendingInject` 拉取。
