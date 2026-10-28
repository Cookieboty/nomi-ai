---
'@nomi-ai/ai-chat': patch
'@nomi-ai/host-electron': patch
'@nomi-ai/types': patch
---

发布前加固与体验修复：Grok 的提示与图片改走临时文件（`--prompt-file`），不再把 base64 图片塞进命令行参数；工作区读写等 IPC 只接受已知标签 / 工作区目录；更新检查阶段卡住时也会超时报错；Linux 上主窗口 / 对话窗口位置改为 resize / move 防抖保存；在输入框里按 Esc 不再关闭中栏 Diff；窗口窄于约 1240px 时四栏随窗口收缩、不再横向溢出；界面模式（精简 / 全量）偏好跨窗口同步；分栏拖拽被系统打断（pointercancel）时恢复原宽度；已拖过对话列宽的用户不再被默认宽度迁移重置（只迁移旧默认 440）；文件预览跨文件切换少读一次磁盘。
