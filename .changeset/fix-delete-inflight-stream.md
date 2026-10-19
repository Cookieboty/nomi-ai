---
'@nomi-ai/ai-chat': patch
---

fix(chat): deleting a conversation while its reply is streaming no longer lets the late chunks bring the deleted messages back into the view (or into the next turn's context). The in-flight stream is aborted on delete, and an empty "current conversation" is no longer treated as still active.
