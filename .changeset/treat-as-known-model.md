---
'@nomi-ai/gateway': minor
---

第三方模型可以指定「按哪个已知模型处理」：中转改了名的已知模型（如 Aerith-opus → claude-opus），上下文、输出上限、能力、长上下文分档和价格都按它算；任何模型也可以手填标准窗口，开启按标签切换的长上下文。Claude 系列声明超过 200K 时，网关会给第三方 Messages 上游带上 context-1m beta；上游不认就去掉重试，之后不再带。
