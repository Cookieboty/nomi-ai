---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/contract': patch
---

委派给编程助手不再每次都开 worktree：默认直接在工作目录里改，同一仓库里并行的任务改到同一个文件时按重要程度让路；只有指定基于另一个分支做时才开 worktree，做完落地（改动少拷回工作区，改动多提交到新分支 `nomi/…`）并清理，启动时也会清理遗留的 worktree。同一种委派接着用上一次的会话；委派出去的会话只在 Nomi 里查看，不再出现在侧栏和编程助手的历史里。
