---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

fix(cli): third-party models in Claude Code / Codex / Grok tabs get the same thinking-depth slider as Nomi chat, and official account login/remove no longer trips over Nomi's own processes.

- Thinking depth: the tiers come from the gateway's per-model capability (same `ProfileOf` as the main chat, no "off" tier, default = the second tier). The choice goes to the tab's gateway binding, updates live without restarting the CLI, and now overrides the reasoning a CLI sends on its own (Codex always sends one), except an explicit "disabled".
- Accounts: the login CLI runs in a temp directory instead of the account directory, and the "other CLI processes are using this account" check ignores Nomi's own process tree, stale Claude session files and recycled pids. When genuinely external processes are found, removal offers to stop them instead of leaving an account that can be neither used nor deleted; a cancelled login is stopped before its account is removed.
