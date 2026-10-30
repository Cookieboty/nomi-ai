---
'@nomi-ai/ai-chat': patch
---

fix(desktop-go): Windows 上往对话窗口粘贴从资源管理器复制的文件能拿到文件路径了（之前剪贴板读取用错了系统 DLL 名，粘贴文件时读不到路径）。
