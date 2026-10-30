---
'@nomi-ai/core': minor
'@nomi-ai/contract': minor
---

编程助手页可以看到安装 / 更新要用的本机环境：Node.js 版本与路径、npm，以及当前 Node 满足哪些编程助手的最低要求（新增契约查询 `cliUpdate.environment`）。装到用户目录的编程助手不再被 PATH 上更早的旧版本挡住：装好后探测与启动都优先用它，重启后仍然有效；改用全局安装后恢复按 PATH 查找。Node 版与 Go 版一致。
