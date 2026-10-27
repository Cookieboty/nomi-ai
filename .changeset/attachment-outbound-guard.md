---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

fix(privacy): dropped-in text attachments and coding-assistant handoff reports in chat history now follow "Only local models can read files" and the first-cloud-send confirmation (#149, #117). The main process checks the actual receiver before the request leaves: a new attachment that isn't allowed is refused with a clear message, and attachment bodies or handoff reports from earlier turns are replaced with a placeholder instead of being sent to the cloud model.
