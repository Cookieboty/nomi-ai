# 右栏「改动」：自己提交、与远端同步、worktree

右栏「改动」现在只读：`ai:harness:git-diff` / `git-branch` 两个接口，提交只能「让助手提交」——把指令填进输入框交给编程助手。
这篇规划让用户在右栏里直接暂存、提交、拉取、推送，并且认出 worktree。

## 1. 布局

```
┌ 改动 | 文件                     ⟳ ⤢ ▣ ┐
│ ⑂ feat/x  origin/feat/x   ⇣ ↓1  ↑2     │ ← 分支栏：与上游的差距；检查远端 / 拉取 / 推送
│ 过滤…                                  │
│ 已暂存 2                          [−]  │
│ 未暂存 3                          [+]  │
│  …文件列表（可滚动，每行悬停有 + / −）… │
├────────────────────────────────────────┤
│ [提交信息（⌘↩ 提交）              ]    │ ← 底部固定
│ ☐ 提交后推送        让助手提交  [提交] │
└────────────────────────────────────────┘
```

- 操作区固定在面板底部，文件列表在中间滚动。
- 「提交后推送」对两种提交都生效：自己提交时提交完接着推送，「让助手提交」时指令里要求推送。
- 工作区干净时没有底栏；有没推送的提交时，分支栏的 `↑N` 就是推送按钮。

## 2. 自己提交

- 暂存 / 取消暂存：每行一个按钮，分组标题上有整组的按钮。
- 提交哪些文件：
  - 有已暂存的内容 → 只提交已暂存的；
  - 没有 → 先暂存当前列表里的文件（有过滤或「只看本会话」时就是过滤后的那些），再提交。
- 提交钩子照常运行，不加 `--no-verify`。提交的超时是 5 分钟（lint-staged 可能跑十几秒）。
  钩子或 commitlint 拒绝时显示 git 的输出，提交信息保留。
- 提交成功后显示短提交号和「撤销」：`git reset --soft HEAD~1`，只在 HEAD 仍是这个提交、而且还没推送时允许。

## 3. 与远端同步

- 分支栏显示上游分支和 `↑ahead ↓behind`（`rev-list --left-right --count @{u}...HEAD`）。没有上游时显示「未推送到远端」。
- **检查远端**：`git fetch <上游的远端>`。
- **拉取**：`git pull --ff-only`。分叉时不合并、不变基，提示让助手处理或去终端合并。
- **推送**：总是写明 refspec：`git push <远端> HEAD:refs/heads/<分支>`，没有上游时加 `-u`（远端取 `branch.<b>.pushRemote` → `remote.pushDefault` → `origin` → 唯一的远端）。
  显式 refspec 不带 `+`，所以 `remote.<name>.push` 里配置的强推也不会生效。**永不 force-push。**
- 游离 HEAD 不能推送、拉取。
- 不弹交互输入：`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`，用系统凭据助手或 SSH agent。认证失败时提示去终端登录一次。网络操作超时 2 分钟。

## 4. 接口

都在 `packages/electron/src/cli/gitOps.ts`，IPC 经 `knownDir(cwd)` 校验；参数用 `execFile` 数组传，路径加 `--literal-pathspecs`、放在 `--` 之后，并且必须落在 cwd 里。
同一个目录同时只跑一个写操作（另一个返回 `busy`）。

| 通道                                             | 作用                                                 |
| ------------------------------------------------ | ---------------------------------------------------- |
| `ai:harness:git-sync-status`                     | 分支、上游、ahead / behind、远端列表                 |
| `ai:harness:git-stage` / `git-unstage`           | 暂存 / 取消暂存一组路径                              |
| `ai:harness:git-commit`                          | `{ message, paths? }`：有 paths 时先暂存它们，再提交 |
| `ai:harness:git-commit-undo`                     | `{ sha }`：软撤销刚才的提交                          |
| `ai:harness:git-fetch` / `git-pull` / `git-push` | 同上                                                 |

写操作返回 `{ ok, code?, output? }`。`code` 是 `busy | auth | diverged | rejected | hook | nothing | detached | no-remote | timeout | error`，界面按它给提示，`output` 是 git 的原始输出（截到 8 KB）。

## 5. worktree（P2）

- 识别：`git rev-parse --git-dir` 与 `--git-common-dir` 不同，就是附属 worktree；分支栏标出来，悬停显示主仓库。
- 切换：`git worktree list --porcelain` 列出同一仓库的 worktree，`.nomi-delegate/<id>` 标「委派任务」。
- `knownDir` 放宽一条：已知目录所在仓库的 `git worktree list` 里的路径也算已知（路径来自 git，不来自渲染进程）。
- 这一轮工具调用改的文件落在别的 worktree 里时提示「助手在 worktree X 里改了 N 个文件」。

## 6. 分阶段

| 阶段 | 内容                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------- |
| P1   | 底部操作区、暂存 / 取消暂存、自己提交、撤销、与上游的差距、检查远端、拉取（仅快进）、推送（不强推） |
| P2   | worktree 识别、切换、`knownDir` 放宽、改动落在别的 worktree 时的提示                                |
| P3   | 辅助模型根据 diff 生成提交信息（走网关，受外发保护）；放弃改动（要确认）                            |
