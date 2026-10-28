---
'@nomi-ai/ai-chat': minor
'@nomi-ai/host-electron': minor
'@nomi-ai/bundle-ig-base': minor
---

feat(chat): Nomi conversations get a workspace picker in the chat header, like the coding-agent tabs. The workspace is stored per conversation (new ones default to Documents/nomi; "No workspace" goes back to granted folders). With a workspace, Nomi's file tools work inside it without a folder grant (relative paths allowed); outside it only folders and files you granted yourself are reachable, through the usual grant and confirmation flow (never auto-approved), and other paths are refused. A new `workspace_run` tool runs shell commands in the workspace, and coding agents Nomi hands work to start in it. New setting Coding agents → Permissions → "Auto-approve everything (full access)", on by default: file and command actions inside the workspace run without asking, and new coding-agent tabs and handed-off agents start in Full access; turn it off to be asked again. Plan mode, the sensitive-path deny list and paths outside the workspace are still refused. The default working directory is now Documents/nomi instead of Documents (created on first use; a main tab still on Documents moves there); tabs still on the old default mode move to Full access once.
