---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

fix(cli): a coding-agent conversation that already ran on a third-party provider stays on the model it last used when you change this CLI's default provider on the Models page, instead of silently moving to the new default. Reopening it from history also resumes on that model (Nomi now remembers each session's third-party model; older Claude sessions are recovered from the gateway's session record). If that provider has since been removed or disabled, the tab falls back to the default. New tabs still use the default. In the model button, such a conversation lists all models of both its original provider ("This chat's provider · A") and the current default provider ("Default provider · B"); once you switch to the default and send a message, only the default provider is left.
