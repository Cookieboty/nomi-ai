---
'@nomi-ai/desktop-go': patch
---

fix(tasks): 委派用的 worktree 里，编程助手自己提交了、还没有分支指着的改动，落地或启动清理时先留在新分支 `nomi/…` 上再拆；留不住时保留 worktree 并报错，不再因为工作区干净就当作没有成果删掉（#267）。/ Commits a coding assistant made in a delegation worktree that no branch points to are now kept on a new `nomi/…` branch before the worktree is landed or swept at startup; if that fails the worktree is kept and the error reported, instead of treating a clean status as no work and deleting it (#267).
