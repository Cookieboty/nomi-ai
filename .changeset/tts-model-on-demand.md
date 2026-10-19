---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/renderer': minor
'@nomi-ai/types': minor
'@nomi-ai/ui': minor
---

离线语音模型不再打进安装包（各平台安装包约小 132 MiB 解压内容），改为在「设置 → 语音与屏幕 → 语音」开启语音时从 sherpa-onnx 官方 release 下载到本机（约 115 MB，sha256 校验），显示进度，可取消、重试、删除，中途退出后下次断点续传；下载完成后完全离线可用。新安装默认关闭语音；之前开着语音的用户保持开启，并会在启动时自动下载模型。缺少模型时语音静默并提示，不会崩溃。
