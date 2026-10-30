---
'@nomi-ai/ai-chat': patch
---

feat(ui): every confirmation and the account rename prompt now use Nomi's own dialog instead of the system `confirm` / `prompt` window — deleting providers, keys, accounts, MCP servers, skills, local models, external CLIs, clearing usage / desktop data / the current chat, turning off privacy mode, discarding Git changes, trusting a Gemini folder, closing a running tab, switching a tab from third-party to official. The dialog looks the same on macOS and Windows, follows the app theme and language, and destructive actions get a red button with focus on Cancel.
