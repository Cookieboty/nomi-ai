# 委派 OS 隔离（P3，轻量）

设计见 [nomi-delegate-cli.md §9 P3](../design/nomi-delegate-cli.md)。**不做 Docker-first**。

## 行为

1. Nomi 调用 `delegate_to_cli` 且工作目录在 **git 仓库内**：主进程在已授权的 `cwd` 下创建
   `git worktree`（`.nomi-delegate/<id>`，detached HEAD），编程助手标签的工作目录指向该 worktree。
2. 任务成功结束后，把 worktree 内改动的文件 **拷回仓库根**；worktree 保留以便 `delegate_followup`。
3. 取消 / 授权失败：拆除 worktree。
4. **非 git 目录**：仍在原 cwd 运行，并在 `isolationNote` 中提示并行会互相改文件。
5. 同时 `running` 的委派上限为 **3**。

子 CLI 自带的沙箱（如 Codex Seatbelt）仍然生效；本层只隔离「并行写同一工作树」。

## 残留风险

- 两个委派改同一文件时，后完成的拷回覆盖先完成的。
- 成功路径下 `.nomi-delegate/` 会残留；已写入仓库 `info/exclude`，可用 `git worktree list` / 手动 `git worktree remove` 清理。
