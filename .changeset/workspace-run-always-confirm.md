---
'@nomi-ai/ai-chat': patch
---

fix(security): Nomi's command tool (`workspace_run`) now asks before every command (#186). The workspace only sets the folder a command starts in; the command itself runs as you and can reach files outside the workspace, so "Auto-approve everything (full access)" no longer lets it through: in every permission mode a dialog shows the full command and working directory, and nothing runs until you allow it. Plan mode refuses it. File actions inside the workspace are unchanged. The setting's description and the privacy docs now say this plainly; the Node and Go builds behave the same.
