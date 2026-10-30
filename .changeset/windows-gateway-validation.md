---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/renderer': patch
---

修复 Windows 分数 DPI 下透明窗口初始尺寸与移动时的尺寸累积偏差。补齐 Windows 终端的 PowerShell 入口、任意位置模型覆盖和 Grok / dsh 支持，参数通过独立启动器传递；可经确认加入用户 PATH，关闭时只移除 Nomi 添加的目录。

修复 Codex Desktop 历史来源识别、无标题会话、索引归档刷新和重复 rollout 回退；供应商编辑支持新旧 Key 混合检测、新 Key 排序和协议地址局部更新。
