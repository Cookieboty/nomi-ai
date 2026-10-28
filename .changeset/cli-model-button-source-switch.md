---
'@nomi-ai/ai-chat': patch
---

feat(chat): when a coding-agent tab's source differs from the CLI's "new tabs use" default, the model button offers it directly — a third-party conversation gets "Switch to the official account" when the default is official, and an official one lists the default provider's models when the default is third-party. Switching keeps the tab and its conversation; going from third-party to official still asks first, because the CLI has to continue in a fresh session that carries the conversation (third-party reasoning can't be sent to the official API). `/model` no longer lists "Default model" for a third-party conversation that has already run, and marks the model actually in use.
