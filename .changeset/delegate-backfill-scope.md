---
'@nomi-ai/electron': patch
---

fix(delegate): when a handoff runs in a git worktree, changes are copied back to the main working tree only for files inside folders you have authorized. Files the coding assistant changed elsewhere in the same repository stay in the worktree and are listed as not applied automatically (#115).
