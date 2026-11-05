---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

fix(chat): 思考状态补齐开始 / 结束事件：只上报思考状态、没有思考内容的模型也会显示「正在思考」，正文开始输出、工具开始执行或这一轮结束 / 失败 / 中止后不再一直显示思考中；普通 Nomi 对话不再展示思考原文，只保留状态与时间线，编程助手对话不变。/ Thinking now has explicit start / end events: models that report thinking without any text still show "Thinking", and the indicator ends once the reply or a tool starts, or the turn finishes, fails or is stopped. Regular Nomi chats no longer show the raw thinking text (status and timeline stay); coding-assistant chats are unchanged.
