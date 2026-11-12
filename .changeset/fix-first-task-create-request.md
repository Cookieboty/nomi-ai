---
'@nomi-ai/ai-chat': patch
---

fix(tasks): 修复首次从命令面板选择「新建任务」时只打开列表的问题；任务页尚未加载时也会打开创建表单，取消后不会重复打开。/ The first New task command now opens the creation form even before the task page has loaded, without reopening it after cancellation.
