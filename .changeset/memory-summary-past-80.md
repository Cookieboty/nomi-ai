---
'@nomi-ai/ai-chat': patch
---

fix(memory): automatic conversation summaries no longer stop updating once a chat passes 80 messages. New-content detection now uses the real message count (only the summarizer's context is limited to the latest 80), and conversations whose history shrank are re-summarized.
