---
'@nomi-ai/host-electron': patch
---

test: tests no longer write git worktrees or `.git/info/exclude` entries into this repo when TEMP points inside it; `run-bin` keeps the system temp unless `NOMI_WORKSPACE_TMP=1`. Fixes the Windows #115 path comparison, the macOS 1 MiB privacy perf check and a cold-start timeout in the Volcengine ASR test.
