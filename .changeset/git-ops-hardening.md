---
'@nomi-ai/host-electron': patch
---

右栏「改动」的 git 操作加固：worktree 只认真属于本仓库的目录，生成提交信息不读未跟踪的软链，写操作按仓库加锁、不带 GIT_OPTIONAL_LOCKS，输出里远端凭据打码，撤销放弃不删仓库外的文件
