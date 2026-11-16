---
'@nomi-ai/ai-chat': patch
'@nomi-ai/desktop-go': patch
---

fix(delegate): 子任务改的文件带回主会话：在子任务里接着对话的一轮原来只回报文字（汇报里列的文件也被清空），委派前就有改动的文件按 git 前后差集被丢掉，失败 / 被停下的一次一个文件都不带；现在按编程助手改文件的工具事件补齐，结果带上子任务标签。主会话的结果消息列出改动文件与增删行数（Nomi 下一轮读得到，不放整段 Diff），下面是和子任务面板同一张「已编辑 N 个文件」卡片，可打开每个文件的 Diff。 A subagent's file changes now reach the main chat: follow-up turns in the subagent used to report text only (even dropping the files listed in its report), files already dirty before the delegation fell out of the git before/after diff, and failed or stopped runs carried no files at all; the edit tool events now fill those in and the result names the child tab. The result message lists the changed files with +/− counts (so the main assistant knows what changed, without full diffs), with the same "Edited N files" card underneath to open each file's diff.
