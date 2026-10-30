---
'@nomi-ai/host-electron': patch
---

语音检测（Silero VAD）推理移到 worker 线程，免手动 / 唤醒词模式下不再每秒 31 次占用主进程；worker 崩溃自动重建，连续失败时退回进程内推理；单帧推理失败按「无语音」处理。
