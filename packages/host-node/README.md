# @nomi-ai/host-node

无界面宿主：`createNodeHostPorts(options)` 返回一份 `HostPorts` 实现和测试用的 `control` 句柄，用于单元测试、无界面 E2E 与开发。设计见 [docs/design/core-host-decoupling.md](../../docs/design/core-host-decoupling.md) §6.3。

- `paths`：临时目录（`dispose()` 删除）或调用方给的 `root`；
- `secrets`：内存里的可逆编码，**不是加密**，只用于测试；
- `dialogs`：按队列返回预设答案（`options.dialogs` / `control.queueDialog`），队列空时视为取消；
- `shell`、`windows`、`lifecycle`：只记录调用（`control.shellCalls` / `windowCalls` / `quitCount`）；
- `power` / `lifecycle` 事件由 `control.emitSuspend()`、`runBeforeQuit()` 等手动触发；
- `appearance`：默认浅色，`control.setSystemDark()` 模拟系统切换；
- `notifications`：只记录（`control.notifications`），`control.clickNotification()` 模拟点击；
- `image`：默认解码不了任何图片（`size` 返回 null、`resize` 抛错），`options.image` 注入实现；
- `processes`：默认不可用，`options.fork` 注入工具子进程实现；
- `capabilities` 全部关闭。

```ts
const { ports, control } = createNodeHostPorts({ dialogs: { pickDirectory: ['/work'] } });
await ports.dialogs.pickDirectory(); // '/work'
control.dispose();
```
