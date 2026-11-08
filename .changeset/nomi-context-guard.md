---
'@nomi-ai/desktop-go': patch
---

fix(chat): Nomi 一轮里连续调工具时，每一步按模型实际用掉的上下文检查：快满时较早的大段工具输出只留开头一截；模型仍提示超出上下文长度时，压得更短后重试这一步一次，不再直接报错。后台的 Nomi 任务也一样，并按所用模型的窗口计算预算。发送前的自动压缩也改为参考上一轮的实际用量，不只靠估算。/ While Nomi calls tools in a row within one turn, it now checks the context the model actually used before each step: when it is nearly full, older long tool outputs are cut down to their opening part, and if the model still rejects the request as too long, the step is retried once with shorter outputs instead of failing. Background Nomi tasks do the same and now size their budget from the model's window. Auto-compaction before sending also takes the last reply's actual usage into account, not only an estimate.
