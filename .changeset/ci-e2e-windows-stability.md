---
'@nomi-ai/host-electron': patch
'@nomi-ai/renderer': patch
'@nomi-ai/types': patch
'@nomi-ai/ai-chat': patch
---

修复 CI 红灯（#64）：诺米缩放后，主进程丢弃渲染进程按缩放前窗口尺寸量出的旧包围盒，脚底锚点不再短暂跳回旧位置；输入栏变窄时权限模式按钮跟着收缩、极窄时只留图标，不再压住语音按钮。测试：知识库撤权单测在 Windows 8.3 短路径下按 native realpath 比较；E26 先切到「订阅额度」分区并关闭主动刷新（不依赖本机装没装官方 CLI）；E27 异步卡片统一放宽等待；E23 放大后拖拽等窗口真正跟上再判定。
