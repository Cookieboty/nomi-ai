---
'@nomi-ai/core': minor
'@nomi-ai/contract': minor
'@nomi-ai/ai-runtime': minor
'@nomi-ai/i18n': minor
---

feat(core): Nomi conversation workspaces. `ChatOptions.extra.cwd` reaches tools as `ToolExecContext.cwd` and is validated in the core (`PermissionBroker.workspaceOf`: a directory the user chose via `knownDir`, not a filesystem root, the home folder or its ancestors, Documents / Desktop / Downloads themselves, system folders or deny-listed paths); unknown workspaces are dropped. Desktop file tools use `guardIn` / `authorizeIn` inside a workspace and fall back to the user's granted scopes with the original authorization outside it (`guardWorkspaceOrGranted`, never auto-approved), `workspace_run` (`requiresWorkspace`, hidden by `toAiSdkToolSet` without a workspace) runs commands with the CLI tabs' environment, timeout, output cap and abort, and `delegate_to_cli` inherits the workspace. `HarnessOrchestrator` gets `autoApprove` (default on, `harness.permissionDefaults({ autoApprove })`, `HarnessTabsState.autoApprove`): new tabs default to `bypass` and keep it across restarts; tabs on the old default migrate once. Nomi's chosen workspaces now enter the recent-directory list. The default working directory is `<documents>/nomi`, created on first use; a persisted main-tab cwd equal to the old default (Documents) migrates to it.
