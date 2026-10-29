---
'@nomi-ai/core': patch
'@nomi-ai/host-ports': patch
'@nomi-ai/contract': patch
'@nomi-ai/host-node': patch
---

refactor(voice/desktop): `WindowsPort` 新增 `isOpen` / `dismissed` / `release` / `ownsCaller` / `onCallerClosed` 与 `WindowIntent.transient`；`DesktopService` / `VoiceService` 只依赖宿主端口，删除 `DesktopWindows` / `VoiceChatWindow` / `VoiceSender` / `callerWindows` / `createVoiceStreams`，流式识别经 `VoiceStreamSink` 推给发起方的流；新增契约过程 `voice.takePendingInject`（`voice.inject` 加入 pending 组）；host-node 新增 `control.bindCaller` / `closeCaller`。
