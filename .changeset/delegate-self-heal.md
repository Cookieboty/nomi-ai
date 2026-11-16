---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(delegate): 委派遇到瞬时错误或编程助手执行中断时自动重试（最多 5 次、带退避），并恢复半死的会话进程；上一次以失败收场的标签不再给新委派复用，出错的委派标签 15 分钟后自动关掉。失败 / 被停下的一次也把已经改了的文件带回来，结果里带上落地目录，来源对话能显示增删行与 Diff。后台委派重试后仍失败时，Nomi 在对话空闲时接手（换一个编程助手或自己完成，每次提问最多两次）。 Delegations retry transient and crashed-executor errors (up to 5 times with backoff) and recover a half-dead session; a tab whose last task failed is no longer reused and failed delegate tabs close after 15 minutes. Failed or stopped runs bring back the files they already edited, the result names the directory the changes landed in, and when a background delegation still fails Nomi takes over while the chat is idle (another coding agent or its own tools, at most twice per question).
