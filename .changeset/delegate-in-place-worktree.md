---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(delegate): 委派给编程助手不再每次都开 worktree：默认直接在工作目录里改，同一仓库里并行的任务改到同一个文件时按重要程度让路；只有指定基于另一个分支做时才开 worktree，做完落地（改动少拷回工作区，改动多提交到新分支 `nomi/…`）并清理，启动时也会清理遗留的 worktree。同一种委派接着用上一次的会话；委派出去的会话只在 Nomi 里查看，不再出现在侧栏和编程助手的历史里。/ Delegating to a coding assistant no longer opens a worktree every time: it edits the working folder directly, and parallel tasks in one repo that touch the same file yield by priority. A worktree is used only when the task is based on another branch; when done its changes land (small ones copied back, large ones committed to a new `nomi/…` branch) and it is cleaned up, with leftovers removed at startup. The same kind of delegation reuses the previous session, and delegated sessions only show in Nomi, not in the sidebar or the coding assistant's history.
