---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/i18n': patch
---

feat(chat): choose a thinking depth for each model

Nomi chat uses the same effort slider as Claude, Codex and Grok, and only shows it when that model can think. The default is the second tier in the model's own list. The choice is kept on the conversation and sent in the parameter shape that model accepts (reasoning effort, thinking budget, thinking level, or an on/off switch). Models that cannot think stay unchanged: the slider stays hidden and no reasoning parameter is sent.
