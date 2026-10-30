---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

refactor(core): each core instance keeps its own interface language, logging switch, private-file root and CLI diagnostics trace, so two cores in one process no longer overwrite each other; the host gets its translator from `core.i18n`. Contract errors are recognised by name and code (not `instanceof`), and the default system prompt is assembled in the kernel. The pronoun the interface uses for the character comes from the character pack (`persona.pronoun`; official「她」/ she, other packs「它」/ it by default), e.g. 「点她的『AI 对话』」.
