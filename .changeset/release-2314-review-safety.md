---
'@nomi-ai/desktop-go': patch
---

fix(tasks): 修复后台任务与编程助手的生命周期和审批回归：CLI 检测与更新同时完成时不再崩溃，缓存进程表不再放行删除被外部 CLI 占用的账号；重复任务自动验收后保留并落地 worktree 成果；命令审核失败不再被「全部自动」放行，显式关闭任务自动判断后逐条询问；追问重试保留文字、图片和上次结论，并隔离每次追问的附件；Codex 子线程快速结束后可继续对话，活动子线程不再被空闲回收。/ Fix background-task and coding-agent lifecycle and approval regressions: concurrent CLI inspection and update completion no longer crash the app, and stale process snapshots no longer allow removal of accounts used by external CLIs. Recurring tasks land automatically accepted worktree changes. Failed command reviews no longer fall through to automatic approval, and disabling task auto-judging restores per-command confirmation. Follow-up retries preserve text, images and prior results, with separate attachment files per request. Fast-finishing Codex child turns remain usable, and active child threads are protected from idle reclamation.
