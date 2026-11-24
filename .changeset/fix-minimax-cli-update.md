---
---

fix(cli): 修复 MiniMax Code 在应用内更新始终卡在旧版本的问题

- 移除 MiniMax Code 清单中的 `selfUpdate: 'always'`，避免在 Nomi 非交互式子进程中调用需要 TTY 确认且直接返回退出码 `0` 的 `mcode update`，统一走 npm 更新
- 在 `CliUpdateService` 中增加版本变化校验：自更新命令退出码为 `0` 但版本未升高时继续回退后续安装方式，全部方式完成后仍未升级到预期版本时判定失败并保留日志
