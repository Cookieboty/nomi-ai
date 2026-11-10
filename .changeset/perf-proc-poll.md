---
'@nomi-ai/desktop-go': patch
---

perf(agents): Agent 看板与进度监控共用 5 秒内的进程列表，不再各起一次 ps / PowerShell；没有编程助手在跑时，进度监控至多每 30 秒读一次进程表（原来每 8 秒），空闲时更省 CPU。
