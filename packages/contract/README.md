# @nomi-ai/contract

视图与内核之间的 API 契约（自研，不用 tRPC / oRPC）。说明见 [docs/development/contract.md](../../docs/development/contract.md)。

不依赖 Node 内置模块：视图（浏览器）能加载；Go 内核的过程表与类型由它生成（`scripts/go-contract/gen.mjs` → `apps/desktop-go/internal/contract/gen`）。

## 用法

```ts
import { createClient, defineContract, implement } from '@nomi-ai/contract';
import { z } from 'zod';

export const contract = defineContract({
  version: { major: 1, minor: 0 },
  procedures: {
    'chat.stream': { kind: 'stream', input: ChatInput, chunk: ChatChunk, output: ChatResult },
    'sessions.list': { kind: 'query', input: z.void(), output: SessionList },
    'tools.confirm': { kind: 'mutation', input: ConfirmInput, output: z.void(), dangerous: true },
    'settings.reset': { kind: 'mutation', input: z.void(), output: z.void(), surfaces: ['settings'] },
  },
  events: { 'usage.updated': UsageSnapshot },
  errors: ['SESSION_NOT_FOUND'],
});

// 内核：缺处理函数、多处理函数、类型不符都编译失败
const router = implement(contract, {
  async *'chat.stream'(input, ctx) {
    yield { type: 'delta', content: '…' };
    return { tokens: 1 };
  },
  'sessions.list': () => sessions,
  'tools.confirm': async (input, ctx) => {},
  'settings.reset': () => {},
}, { middleware: [logCalls] });
router.events.publish('usage.updated', snapshot);

// 视图
const api = createClient(contract, transport);
const list = await api.sessions.list();
const s = api.chat.stream({ prompt }, { signal });
for await (const chunk of s) render(chunk);
const result = await s.result;
const off = api.on('usage.updated', (u) => …);
```

## 要点

| 主题   | 规则                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 过程名 | 点分标识符，生成嵌套 api；`meta.*`、`on`、`$*` 保留；任何一段都不能是 `__proto__` / `constructor` / `prototype` / `then`（过程名与事件名都校验，`createClient` 也会再查一次，嵌套节点是无原型对象）；不能同时有 `a` 和 `a.b`                                                                                                                                                   |
| 校验   | 客户端发出前校验入参、收到后校验结果 / chunk / 事件；服务端校验入参、结果、chunk 与 publish 的事件。都可以用 `validate` 关闭（服务端入参校验不建议关）。schema 不要用 transform：两端都会解析一次                                                                                                                                                                              |
| 错误   | 线上只传 `{ code, message, data? }`。内置码见 `BUILTIN_ERROR_CODES`；业务码在 `errors` 里声明，处理函数用 `ctx.fail(code, message, data)`                                                                                                                                                                                                                                      |
| 取消   | `signal` 或提前 `break` 迭代都会发 abort 帧，处理函数的 `ctx.signal` 触发，客户端以 `ABORTED` 失败。流以任何方式提前结束（取消、断开、chunk 校验失败、chunk 不可序列化）服务端都会调用处理函数迭代器的 `return()`，generator 的 `finally` 一定执行                                                                                                                             |
| 安全   | 传输层填 `CallerContext { surface, trusted }`；内置守卫先于中间件执行：`surfaces` 之外的界面、不可信调用者调 `dangerous` 过程都返回 `FORBIDDEN`                                                                                                                                                                                                                                |
| 版本   | 客户端默认第一次调用前握手（`meta.version`），major 不一致时所有调用以 `VERSION_MISMATCH` 失败；`auto` 模式下握手成功前收到的事件先缓存（每个监听最多 256 条），成功后按序投递，major 不一致时丢弃；minor 只增不删；`deprecated` 的过程第一次调用时 warn                                                                                                                       |
| 序列化 | 只用 JSON 值和 `Uint8Array`。服务端会话的 `strictSerialize`（`createServerSession` 的选项；默认 `NODE_ENV !== 'production'` 时开启，即开发与测试）对每个出站帧跑 `findUnserializable`：`Date` / `Map` / `Set` 等 WebSocket 传不了的值会被拦下，结果 / chunk 以 `BAD_OUTPUT` 失败（流随之停止），事件丢弃并 warn。in-process 传输按自己的 `serialize` 模式（默认 `strict`）检查 |

## 应用契约 `@nomi-ai/contract/app`

`appContract` 是视图与内核之间实际使用的契约（版本 1.0）。本批只含 AI 门面：

| 内容       | 说明                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 过程       | `ai.<facade>.<method>`（35 个，取代两份 `IPC_METHODS`）；读用 query、写用 mutation、流用 stream；`ai.tools.confirm` 为 `dangerous`                                          |
| 位置参数   | `AI_METHODS` 记录门面方法的参数怎么打包成入参（`aiArgsToInput`），`ClientAIClient` 据此保持 `AIClient` 的签名                                                               |
| 事件       | `AI_EVENTS`：`AIClient.on` 的 12 个业务事件 → `ai.<domain>.<name>`；payload 来自插件事件总线，schema 有意放宽（已知字段可缺省、未知字段透传）                               |
| DTO schema | `aiSchemas`：手写对照 ai-sdk / seam 类型，一致性由 ai-runtime 的 `implement(appContract, …)` 编译期检查；`raw`、`signal` 这类不可序列化字段不进契约                         |
| 传输       | Go 内核的契约服务端（`apps/desktop-go/internal/contract`，回环 WebSocket）；视图经 `createWebSocketClientTransport`（`@nomi-ai/ai-sdk-client` 的 `installGoHostTransport`） |

## 线协议

客户端发 `req` / `abort` / `sub` / `unsub`，服务端回 `res` / `chunk` / `end` / `err` / `event`，帧格式见 `src/protocol.ts`。所有传输共用 `createServerSession`（服务端）与 `createFrameClientTransport`（客户端），线协议只在这两处解释。

## 传输

| 实现       | 入口                                                                                | 用途                                                            |
| ---------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| in-process | `@nomi-ai/contract/testing` 的 `createInProcessTransport` / `createInProcessServer` | 单元测试                                                        |
| WebSocket  | `createWebSocketClientTransport({ url, token, surface })`                           | 视图连 Go 内核；身份放在子协议里，服务端校验一次性 token 与界面 |
| 任意帧通道 | `createServerSession` + `createFrameClientTransport`                                | 自定义传输（MessagePort 等）                                    |

```bash
pnpm --filter @nomi-ai/contract typecheck   # 含 tests/ 里的类型断言
pnpm --filter @nomi-ai/contract test
```
