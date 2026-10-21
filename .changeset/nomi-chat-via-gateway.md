---
'@nomi-ai/electron': minor
'@nomi-ai/ai-chat': minor
'@nomi-ai/ai-runtime': minor
'@nomi-ai/gateway': minor
---

Nomi 对话改走本地统一网关，新增设置 →「模型」页：添加第三方供应商只需选预设或贴地址和 Key，Nomi 自动检测可用的协议和模型；对话、工具调用、摘要分别选模型。对话区右上角、托盘和 `/model` 切换的都是这里的分配。已有的供应商在升级时自动迁移（本机 Ollama 等地址无需重新确认）。旧的 Nomi 供应商面板移除，编程助手页的 Nomi 标签改为指向「模型」页。
