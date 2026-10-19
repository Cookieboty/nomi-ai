---
'@nomi-ai/ai-chat': patch
---

fix(chat): with knowledge-base Q&A on, a message queued while another reply is running is still answered via the cited KB path (the mode is frozen when it is queued), and regenerating / editing a KB answer keeps using KB Q&A instead of silently falling back to a plain chat.
