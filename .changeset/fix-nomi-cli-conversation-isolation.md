---
'@nomi-ai/ai-chat': patch
---

fix(chat): going back to the Nomi tab after opening a CLI conversation (sidebar, top tabs, shortcuts, fork) now restores the Nomi conversation, so the next Nomi turn is saved to the conversation that is on screen instead of the CLI mirror entry. Nomi turns can no longer be written into CLI mirror entries.
