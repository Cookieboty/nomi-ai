---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

fix(tasks): 去掉预算拦截。Nomi 自动续跑不再因为累计用量（原来约 300 万 token）停下来让你说「继续」；持续任务不再按每次 token、每次时长、每天费用暂停或判失败，一直做到完成，卡住没有动静的执行仍按超时处理。之前停在「预算用完」的任务，升级重启后自动接着排队。任务详情和授权卡片里不再显示预算。 / Remove budget interception. Nomi's auto-continue no longer stops on accumulated usage (about 3 million tokens before) and asks you to say "continue". Ongoing tasks are no longer paused or failed by per-run tokens, per-run duration or daily cost, and run until done; a run that stops responding still times out. Tasks that were waiting on "budget used up" are queued again after the update. Task details and the authorization card no longer show a budget.
