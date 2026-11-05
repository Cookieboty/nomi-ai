---
'@nomi-ai/desktop-go': patch
---

新增契约 `chatAssets.import`：对话里用户发的图片原图存进素材库（`user-…`，来源「你发送的」），返回 chat-asset 地址，可交给 image_generate 的 edit_image / reference_images；超过 20 MB 或文件头与格式不符的拒绝。Node 版与 Go 版同步。
