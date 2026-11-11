---
'@nomi-ai/ai-chat': patch
---

fix(conversation): 展开的「思考中」内容会跟着新内容自动滚到最新一行；往上翻时不再跟随，翻回底部后恢复。展开时标题只显示「思考中 · 几秒」，不再同时刷新那一句，收起时才显示。/ An expanded "Thinking" block now keeps scrolling to the newest line as it streams; scrolling up pauses following until you scroll back to the bottom. While expanded, its title shows only "Thinking · Ns" instead of also updating the current sentence, which appears when collapsed.
