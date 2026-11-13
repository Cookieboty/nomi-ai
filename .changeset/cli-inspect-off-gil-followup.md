---
'@nomi-ai/desktop-go': patch
---

fix(cli-update): 启动时 GIL 被占用也不再让 CLI 检测超时（#357）；晚到的检测结果回到 jsrt 线程再推送，避免和安装任务并发读写。
