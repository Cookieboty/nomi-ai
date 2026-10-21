---
'@nomi-ai/ai-chat': patch
---

fix(chat): a Nomi message sent in the background while you are looking at a coding-agent tab (a queued message, a slash command that finishes later) is still saved to the Nomi conversation, but the sidebar no longer jumps away from the CLI conversation you are viewing.
