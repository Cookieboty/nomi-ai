---
'@nomi-ai/ai-chat': patch
'@nomi-ai/electron': patch
---

订阅额度保留上一次的结果：再次打开「订阅额度」会立即显示上一次的值并在后台更新，不再先空一下；Claude Code 与 Grok 的额度也会保存下来，重启 Nomi 后无需重新拉取即可看到（之前只有 Codex 会保存）。在「官方账号」里切换账号时，会清掉上一个账号的额度，不会显示给新账号。
