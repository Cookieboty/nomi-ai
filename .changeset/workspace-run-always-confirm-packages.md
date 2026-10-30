---
'@nomi-ai/core': patch
'@nomi-ai/i18n': patch
---

fix(security): `workspace_run` confirms with `force: { dialog: true }`, so auto-approve and remembered approvals no longer skip it and plan mode blocks it; the confirm preview cap goes from 4000 to 16000 characters so the full command is shown. The tool description, the workspace system hint and the auto-approve setting copy now state that commands aren't confined to the workspace (see workspace-run-always-confirm).
