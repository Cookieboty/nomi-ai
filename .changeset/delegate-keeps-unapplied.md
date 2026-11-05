---
'@nomi-ai/desktop-go': patch
---

fix(delegate): 编程助手的委派中途失败时，隔离工作副本里的改动会全部拷回工作区（以前只拷前 50 个文件）；有拷不回去的文件时保留工作副本并写明是哪些，不再连同改动一起删掉（#255）。/ When a delegated coding task fails midway, every change in its isolated worktree is copied back (previously only the first 50 files); if some files can't be copied, the worktree is kept and the result names them instead of deleting them (#255).
