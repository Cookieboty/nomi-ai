---
'@nomi-ai/ai-chat': patch
---

fix: 添加第一个第三方供应商后，Nomi 对话的模型没有自动填上推荐模型（内核的变更通知先于保存结果到达时，添加表单已经收起，跳过了这一步）。/ After adding the first third-party provider, Nomi's chat model is filled in with the recommended model again (it was skipped when the change notification arrived before the save returned).
