---
'@nomi-ai/core': patch
'@nomi-ai/contract': patch
---

fix(core): normalize Windows 8.3 short vs long paths in knownDir / samePath / rememberCwd, and use native realpath for desktop workspace checks so quality and e2e-headed no longer fail with workspaceOf / invalid_path (E37). Declare autoApprove on HarnessTabsState.
