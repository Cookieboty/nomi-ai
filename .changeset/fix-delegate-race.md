---
---

fix(delegate): 委派结果收尾与任务状态对象并发读写（数据竞争）

- `runChild` 启动取消监控 goroutine 前先取登记后不再变化的 `taskId`；goroutine 里不再读运行期间被结果收尾（finalize）写入的任务状态对象 `task.o`，取消监控只认这个 `taskId`
- 后台任务的 `background` 标记与名额归还（`noteLoadLocked` 读状态 / `background`）持同一把锁写读，`-race` 下不再报 `DATA RACE`
- 这些路径都在 Go 桌面内核（changesets 里不参与版本化的包），改动只写一条 empty changeset；桌面应用只随安装包发布，不单独升包版本
