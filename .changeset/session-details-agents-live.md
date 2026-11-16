---
'@nomi-ai/ai-chat': patch
---

fix(ui): 会话详情的 Agents 跟上实时状态：第一次派出子任务 / 子代理时，进行中这一轮里的调用就列出来并算「进行中」；出错后在子任务里「继续」，标签又跑起来时显示进行中，那一轮结束后按它的结果显示；编程助手标签一轮结束后仍在跑的后台子代理也按实时状态显示。Session details' Agents follow live status: sub-tasks / sub-agents started in the running turn show up (as running) right away; after an error, continuing in the sub-task shows it running again and then the follow-up's result; background sub-agents still running after a coding-agent turn ends keep their live status.
