# 应用契约

视图（`packages/ai-chat`、`packages/renderer`）对内核的全部调用与推送都走应用契约。契约只在
`packages/contract` 里定义一次（zod schema），Go 内核的过程表、类型与未实现桩由它生成。

```
packages/contract/src/app/<域>.ts   ──pnpm --filter @nomi-ai/contract build──▶ dist
                                     ──node scripts/go-contract/gen.mjs──────▶ apps/desktop-go/internal/contract/gen/
视图：services/api.ts 的 api.<域>.<过程>(…)  ⇄  回环 WebSocket  ⇄  Go：internal/contract.Router → internal/core/<域>handlers
```

## 契约里有什么

| 内容       | 位置                                                                    | 说明                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 过程       | `packages/contract/src/app/{ai,shell,coding,knowledge,media,mascot}.ts` | 点分名字（`appIcon.set`）；`query` / `mutation` / `stream`（stream 另有每个 chunk 的 schema）                                                          |
| 事件       | 同上，`events`                                                          | 内核推给视图；视图 `api.on(name, fn)` 订阅后才收到                                                                                                     |
| 业务错误码 | 各域的 `errors`                                                         | 例如 `KB_EMPTY`、`SCHED_NOT_FOUND`；生成到 Go 的 `gen.Errors`                                                                                          |
| 版本       | `appContract.version`                                                   | 客户端第一次调用前经 `meta.version` 握手，major 不一致时调用以 `VERSION_MISMATCH` 失败；Go 侧回的是 `internal/contract/frames.go` 的 `ContractVersion` |

过程的访问控制写在定义上，由两端的守卫判定（Go：`internal/contract/frames.go` 的 `guard`）：

- `surfaces`：允许调用的界面（`chat` / `mascot` / `settings`），不写 = 所有界面；不符返回 `FORBIDDEN`。
- `dangerous: true`：只接受可信调用者（会改文件、执行命令、动密钥的过程）。
- 调用方的界面由宿主认定：每个窗口一个一次性 token，内核记 token → 界面，子协议里自报的界面与之不符直接拒绝握手
  （`internal/contract/websocket.go`）。视图选不了自己的身份。

## 传输

- Go 宿主创建窗口时，把 `ws://127.0.0.1:<端口>` 与这个窗口的 token 放在页面地址片段里（`#ws=…&token=…`，片段不发给服务器）。
- 视图的 `services/api.ts` 在建客户端之前调 `installGoHostTransport(surface)`（`@nomi-ai/ai-sdk-client`），读到配置就装上
  WebSocket 传输（`createWebSocketClientTransport`，只认 `127.0.0.1`）。一个窗口只有一个契约会话，`api` 与 AIProvider 里的
  `ClientAIClient` 共用它。
- 不在 Nomi 窗口里时（测试、浏览器预览）没有传输：`hasTransport()` 为 false，调用以 `BRIDGE_MISSING` 失败。
- 线协议：客户端发 `req` / `abort` / `sub` / `unsub`，服务端回 `res` / `chunk` / `end` / `err` / `event`（`packages/contract/src/protocol.ts`）。
  只用 JSON 值与 `Uint8Array`（WebSocket 上按 `wire.ts` 编成 base64），`Date` / `Map` / `Set` 不能过线。
- 窗口关闭时宿主撤销它的 token 并断开连接；断线后客户端按退避重连，事件订阅在重连后恢复。

## 加一个过程

1. 在对应域的 `packages/contract/src/app/<域>.ts` 里加定义（input / output schema、`surfaces`、`dangerous`）。
2. 生成 Go 侧：

   ```bash
   pnpm --filter @nomi-ai/contract build
   node scripts/go-contract/gen.mjs          # --check 只检查（CI 在 Linux 上跑）
   ```

   生成物 `internal/contract/gen/{procedures_gen,types_gen}.go`、`contract.schema.json` 勿手改。

3. 在 Go 里实现：按域放在 `internal/core/<域>handlers`（`shellhandlers`、`codinghandlers`、`knowledgehandlers`、`mediahandlers`、
   `mascothandlers`），用 `r.Call(name, …)` / `r.Stream(name, …)` 注册，在组合根（`main.go` / `*_wiring.go`）里装上。
   没注册的过程由 `internal/procs` 补成返回 `UNAVAILABLE` 的桩，视图总能拿到明确的错误。
4. 视图里经 `api.<域>.<过程>(…)` 调用。只有 `services/api.ts` 建客户端、选传输（eslint 拦下其余位置）；共享包（`@nomi-ai/ui`、
   `@nomi-ai/voice`）需要宿主能力时走 `services/hostBackends/<域>.ts` 注入。
5. 推事件：Go 侧 `r.Emit(event, data)`（所有订阅了的窗口）或 `r.EmitTo(event, data, surface)`（只推给某个界面）；事件名先在契约里声明。

## 测试

- `packages/contract/tests`：schema、过程表快照、WebSocket 传输、线协议。
- 视图里用 `@nomi-ai/contract/testing` 的 in-process 传输或 `packages/ai-chat/tests/helpers/fakeApi.ts` 的假内核。
- Go 里 `internal/contract/*_test.go` 测路由、守卫与 WebSocket 握手；各 handlers 包测自己的过程。
