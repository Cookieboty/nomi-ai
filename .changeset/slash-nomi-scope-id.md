---
'@nomi-ai/ai-chat': patch
---

fix(chat): the result of a slash command that finishes later (a skill, /diff, /context …) started in an empty Nomi conversation is no longer delivered into a different new empty conversation; Nomi results are bound to the real conversation id instead of "new".
