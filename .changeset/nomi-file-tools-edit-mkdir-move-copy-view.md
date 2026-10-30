---
'@nomi-ai/ai-chat': patch
---

Nomi 对话的文件工具补齐增删改查：新增 `fs_edit`（按原文逐处替换，不用重写整个文件）、`fs_mkdir`、`fs_move`（移动 / 重命名）、`fs_copy`，都可撤销；`fs_write_text` 新建文件时会一并新建缺失的上级文件夹（只在已授权的范围内）；访问未授权位置失败时提示模型先请用户授权文件夹。Node 版与 Go 版一致。
