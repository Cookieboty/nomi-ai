---
'@nomi-ai/host-electron': patch
---

fix(knowledge): after you revoke a folder's access, knowledge-base search, Q&A and the `kb_search` tool stop using that folder's cached snippets right away (previously they kept returning them until the next scheduled index, up to 30 minutes). The folder's cached index is also cleaned immediately, and an index run that was in progress when you revoked can no longer write the file back. Folders that are still covered by another grant keep working.
