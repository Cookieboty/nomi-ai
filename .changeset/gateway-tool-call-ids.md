---
'@nomi-ai/gateway': patch
---

第三方供应商的工具调用 id 更稳：上游没给 id 时（Gemini、正文里写出的工具调用）按对话历史确定地生成，重试或下一轮带回的历史逐字节一致，不再让上游的提示缓存失效；Kimi 等上游给出 `functions.bash:0` 这类带标点的 id 时，转给 Claude Code 会改成它接受的格式，下一轮再还原成上游原来的 id；发给 OpenAI Chat 的超长 id 自动缩短。
