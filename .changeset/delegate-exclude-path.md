---
'@nomi-ai/host-electron': patch
---

fix(delegate): the `.nomi-delegate/` ignore rule is now written to the target repository's `info/exclude` even when Nomi was started from another folder, so worktree handoff folders no longer show up as untracked files (#139).
