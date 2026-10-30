# @nomi-ai/cli-sdk

编程助手（Claude Code、Codex、Grok、Gemini、dsh 及以后的 CLI）的插件契约与共享会话驱动。
设计见 [docs/design/cli-plugin-architecture.md](../../../../docs/design/cli-plugin-architecture.md) §5。

纯 Node，**不依赖 Electron**：主进程、插件的 `main` 入口与测试都能用。

## 内容

| 模块                 | 说明                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `manifest`           | `CliManifest`（纯数据清单）、`validateManifest`、`effectiveCapabilities`                |
| `plugin`             | `defineCliPlugin`、`CliMainImpl` 能力接口（启动、会话定制、历史、账号…）、`AgentLaunch` |
| `events`             | `HarnessEvent`（一轮的界面事件）、`SessionEvent`（会话级事件流）、`PermissionAnswer`    |
| `driver`             | `SessionDriver` 契约、`EventHub`（同步监听 + AsyncIterable）                            |
| `rpc/jsonrpc`        | stdio 上换行分隔的 JSON-RPC 2.0（ACP 与 Codex app-server 共用）                         |
| `drivers/acp`        | ACP 驱动：initialize、session/load·new、set_mode、set_model、prompt、cancel、多选项权限 |
| `drivers/appServer`  | app-server 驱动：thread/start·resume、turn/start·interrupt、审批、用量                  |
| `drivers/streamJson` | stream-json 驱动：用户消息、control_request ↔ control_response、can_use_tool            |
| `drivers/exec`       | exec 驱动：每轮一个进程、按行解析                                                       |
| `launch`             | 启动注入通用实现：环境叠加与剔除、进程级文件、私有 HOME、共享条目软链                   |

驱动**不自己 spawn**：宿主负责可执行文件解析、环境注入与诊断记录，把子进程（`ChildLike`）交给驱动；
exec 驱动每轮起进程时用宿主注入的 `SpawnFn`。CLI 专属的行解析器、条目映射由插件给（`parseLine`、`mapItem`）。

## 事件流的两种读法

```ts
const off = driver.on((e) => {
  if (e.kind === 'harness' && e.turnId) render(e.event); // 同步，与协议消息同序
});
for await (const e of driver.events) log(e); // AsyncIterable：插件 / 测试
```

编排层用同步监听：一轮的结果（`send()` 的 Promise）在最后一个增量事件之后才兑现。
