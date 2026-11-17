---
'@nomi-ai/cli-catalog': patch
---

fix(cli): 清单给 Grok 补上「自动」档，映射到 CLI 的 acceptEdits；此前没有这一档，选「自动」会掉回逐项确认。

The manifest now gives Grok an `auto` tier mapped to the CLI's acceptEdits; without it, picking "auto" fell back to asking every time.
