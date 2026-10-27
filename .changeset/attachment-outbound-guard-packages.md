---
'@nomi-ai/ai-runtime': patch
'@nomi-ai/i18n': patch
---

fix(privacy): the IPC transport gains a `prepareChat` hook that runs in the main process before a chat request is sent, plus the messages for blocked attachments (see attachment-outbound-guard).
