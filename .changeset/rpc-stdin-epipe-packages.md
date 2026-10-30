---
'@nomi-ai/cli-sdk': patch
---

ACP / JSON-RPC 连接监听子进程 stdin 的错误：对端先退出时写入报的 EPIPE 按「进程已退出」让未完成的请求失败（和 close 同一原因，Codex 起不来 app-server 时照常回退 exec），不再变成进程级未捕获错误（外部插件试运行时命令立刻退出的情况）。
