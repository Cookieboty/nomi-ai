---
'@nomi-ai/desktop-go': patch
---

fix(privacy): 分页读被截短的长工具输出、长任务里把较早步骤交给摘要模型时，按那一次实际接收的模型重新检查「仅本地模型可读文件」和云端确认：对话换成云端模型后读不出之前本地模型读到的文件、命令输出和网页，云端的摘要模型也拿不到这些正文（换成占位）。/ Reading pages of a cut-down long tool output, and handing earlier steps of a long task to the summary model, now re-check "only local models can read files" and cloud consent against the model actually receiving them: after a chat switches to a cloud model it can no longer page through files, command output or web pages a local model read earlier, and a cloud summary model gets placeholders instead of that content. (#287, #288)
