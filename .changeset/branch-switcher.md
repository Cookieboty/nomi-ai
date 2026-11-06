---
'@nomi-ai/ai-chat': patch
'@nomi-ai/contract': patch
'@nomi-ai/desktop-go': patch
---

feat(git): 分支切换：新会话输入框上方与右栏「改动」顶部的分支名可以点开，搜索本地分支（按最近提交排序，当前分支打勾）、切过去，或「创建并检出新分支」。有会被覆盖的未提交改动时 git 拒绝切换（不丢改动），原因显示在菜单里；助手正在跑时右栏不能切。新增契约过程 `harness.gitBranches` / `harness.gitCheckout`（分支名先过 `git check-ref-format`，与拉取 / 推送共用同一把仓库锁）。/ Branch switching: the branch name above a new chat's composer and at the top of the Changes panel opens a searchable list of local branches (most recent first, current one checked) to switch to, plus "Create and check out a new branch". git refuses the switch when uncommitted changes would be overwritten (nothing is lost) and the reason stays in the menu; the panel can't switch while the agent is running. New contract procedures `harness.gitBranches` / `harness.gitCheckout` (names go through `git check-ref-format` and share the repository lock with pull / push).
