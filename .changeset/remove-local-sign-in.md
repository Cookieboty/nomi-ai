---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(cli): remove the "this computer's sign-in" option for every built-in coding assistant. Claude Code, Codex, Grok, Kimi Code and MiniMax Code now run only on Nomi-managed official accounts (each in its own config folder, sign-in done by the CLI) or on third-party models through the Nomi gateway; dsh and Gemini, which have no official accounts, run only on third-party models, and their old "own config" default is gone.

- Existing data migrates on start: the old `local-<kind>` account record and any default that pointed at it are dropped, tabs pinned to it follow the default official account, the "New sessions use" setting falls back to "Follow the default account", and dsh / Gemini tabs switch to the third-party source (a new session carrying the conversation).
- With no official account yet, new tabs use the assigned third-party model; otherwise starting the tab explains how to add an account or pick a third-party model instead of falling back to the CLI's own login.
- The default account is the chosen one, else the first signed-in account, else the first account.
