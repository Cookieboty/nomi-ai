---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

fix(cli): saving the coding-agent provider profile that is currently in use now writes the CLI config and stores the profile in a single step in the main process. If writing the CLI config fails, the previous endpoint, model and key stay in effect everywhere (also after a restart); a closed window or a failed second call can no longer leave a new key paired with the old endpoint.
