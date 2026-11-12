---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix: protect diff editor saves with revision validation, retain failed drafts for retry, and preserve edits made while saving. Ignore disk reads superseded by a save and refresh Git even when the editor switches files or modes during saving.
