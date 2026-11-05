---
'@nomi-ai/desktop-go': patch
---

fix(tasks): 打开还没运行过的任务的详情时报「Invalid output of 'tasks.get'」：执行记录为空时内核返回了 null，现在返回空列表。/ Opening a task that has never run no longer fails with "Invalid output of 'tasks.get'": an empty run history is returned as an empty list instead of null.
