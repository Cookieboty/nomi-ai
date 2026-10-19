---
'@nomi-ai/ai-chat': patch
'@nomi-ai/ui': patch
---

fix(chat): the slash-command palette (and the other menus that pop up from the input box) no longer sits underneath the message text. The chat background feature gave every chat-area child `z-index: 1` while the input area had no z-index, so the whole input area — including its popups — was painted below the messages; the input area now has an explicit higher layer (`--cd-z-chat-input`) and the chat container is its own stacking context.
