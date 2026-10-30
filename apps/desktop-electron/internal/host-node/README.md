# @nomi-ai/host-node

无界面宿主：`createNodeHostPorts(options)` 返回一份 `HostPorts` 实现和测试用的 `control` 句柄，用于单元测试、无界面 E2E 与开发。设计见 [docs/design/core-host-decoupling.md](../../../../docs/design/core-host-decoupling.md) §6.3。

- `paths`：临时目录（`dispose()` 删除）或调用方给的 `root`；
- `secrets`：内存里的可逆编码，**不是加密**，只用于测试；
- `dialogs`：按队列返回预设答案（`options.dialogs` / `control.queueDialog`），队列空时视为取消；
- `shell`、`windows`、`lifecycle`：只记录调用（`control.shellCalls` / `windowCalls` / `quitCount`）；
- `power` / `lifecycle` 事件由 `control.emitSuspend()`、`runBeforeQuit()` 等手动触发；
- `appearance`：默认浅色，`control.setSystemDark()` 模拟系统切换；
- `notifications`：只记录（`control.notifications`），`control.clickNotification()` 模拟点击；
- `image`：默认解码不了任何图片（`size` 返回 null、`resize` 抛错），`options.image` 注入实现；
- `processes`：默认不可用，`options.fork` 注入工具子进程实现（`forkUtilityProcess` 是 Node 子进程的实现：经 IPC 在子进程里补上 Electron 约定的 `process.parentPort`）；
- `capabilities` 全部关闭。

```ts
const { ports, control } = createNodeHostPorts({ dialogs: { pickDirectory: ['/work'] } });
await ports.dialogs.pickDirectory(); // '/work'
control.dispose();
```

## 无界面内核：`@nomi-ai/host-node/core`

`startHeadlessCore(options)` 用上面的端口建一个完整内核（`createCore` + `start()`），并用 in-process 传输接上类型化的
契约客户端；无界面 E2E（`e2e/`）与 `pnpm dev:web` 用它。没有宿主片段：要用窗口对象的过程（诺米窗口、灵动岛、应用图标）
以 UNAVAILABLE 失败。

```ts
const h = await startHeadlessCore({ logLevel: 'warn' });
const { api } = h.connect(); // 一个连接 = 一个窗口，默认 { surface: 'chat', trusted: true }
await api.theme.set({ pref: 'ink' });
h.control.windowCalls; // 内核要求打开的窗口
await h.stop(); // 停内核、断连接、删临时目录
```

`host.aiPluginsAfter` 可以往内核的插件宿主里加插件（装在内置插件之后），e2e 用它换上假的 LLM / 工具。
`processes: true` 用 `forkUtilityProcess` 跑统一网关与文档解析子进程（`pnpm dev:web` 打开，e2e 不开）；无界面内核的
网关端口缺省为 0（系统分配，`config.gatewayPort`），不和本机装着的 Nomi 抢 18721。

## 契约的 WebSocket 传输：`@nomi-ai/host-node/websocket`

开发态让视图在普通浏览器里连内核（视图侧是 `@nomi-ai/contract` 的 `createWebSocketClientTransport`）：

```ts
const token = createDevToken();
const server = await serveContractOverWebSocket(core.router, {
  token,
  allowedOrigins: ['http://127.0.0.1:6128'],
});
// server.url = ws://127.0.0.1:<port>；await server.close()
```

只监听回环地址；校验 Host、Origin（完全匹配）、子协议里的一次性 token（常数时间比较，日志只露前 4 位）与界面；普通 HTTP
回 426，二进制帧断开连接。`createNodeWebSocketFactory({ origin })` 给 Node 里的客户端（测试、脚本）带上 Origin。
