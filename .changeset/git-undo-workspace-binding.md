---
'@nomi-ai/host-electron': patch
'@nomi-ai/ai-chat': patch
---

fix(git): in the Changes panel, switching to another worktree while a Git action is still running no longer carries its late result over. The "Undo discard" for worktree A can no longer restore A's stash into worktree B — the main process also checks that the stash was made in the same worktree — and late commit messages or notices don't overwrite the new worktree's draft (#152).
