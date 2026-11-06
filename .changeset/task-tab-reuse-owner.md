---
'@nomi-ai/desktop-go': patch
---

fix(tasks): 两个同类后台任务同时准备时，不会再同时领到同一个空闲的编程助手标签：后领的一方发现标签已被领走就改为新建，不再覆盖前一个任务的归属、也不会因「上一轮仍在运行」失败（#269）。/ Two background tasks of the same kind preparing at once no longer both take the same idle coding-assistant tab: the later one sees it was already taken and opens a new tab instead of overwriting the first task's ownership or failing with "previous turn still running" (#269).
