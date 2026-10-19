---
'@nomi-ai/ui': patch
---

fix(chat): results of slash commands that finish asynchronously (skill expansion, /diff, /context and the other cards, error notices) now always go back to the conversation that started them. Switching tabs while a command is running no longer sends the expanded prompt, or shows the card or error, in the other tab or the Nomi chat; if the original tab was closed or reset the result is discarded (with a notice when the conversation still exists). The input box is only cleared when you are still in the conversation that ran the command.
