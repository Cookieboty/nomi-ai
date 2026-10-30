---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

feat(gemini): when Gemini CLI refuses to run because the folder isn't trusted, the error card now offers "Trust this folder". After a confirmation that explains what trusting means (including a warning for broad folders such as your home folder or Documents), Nomi adds just that folder to Gemini's own trusted folders list (`trustedFolders.json`, written atomically under Gemini's lock, keeping existing entries) and retries the turn.
