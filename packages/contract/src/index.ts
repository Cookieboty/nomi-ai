/**
 * @nomi-ai/contract —— 视图与内核之间的 API 契约（docs/design/core-host-decoupling.md §4、§5、§8）。
 *
 * - `defineContract`：过程（query / mutation / stream）+ 事件 + zod schema + 版本号；
 * - `createClient`：视图侧类型化 api；
 * - `implement`：内核侧处理函数表 → Router（内置 surfaces / dangerous 守卫 + 中间件）；
 * - 线协议与传输：`ClientTransport` / `ServerTransport`、基于帧的通用实现、IPC 形状的适配；
 *   in-process 传输在 `@nomi-ai/contract/testing`。
 *
 * 本包不依赖 electron，也不依赖 Node 内置模块：视图（浏览器）与内核都能加载。
 */

export {
  defineContract,
  getEventSchema,
  getProcedure,
  isCompatible,
  META_VERSION,
  SURFACES,
  type AnyContract,
  type ChunkOf,
  type Contract,
  type ContractDefinition,
  type ContractVersion,
  type ErrorCodeOf,
  type EventData,
  type EventInput,
  type EventMap,
  type EventName,
  type EventsOf,
  type HandlerChunkOf,
  type HandlerOutputOf,
  type InputOf,
  type MutationDef,
  type OutputOf,
  type ParsedInputOf,
  type ProcedureDef,
  type ProcedureKind,
  type ProcedureMap,
  type ProcedureName,
  type ProceduresOf,
  type QueryDef,
  type Schema,
  type ServerInfo,
  type StreamDef,
  type Surface,
} from './contract';

export {
  abortedError,
  BUILTIN_ERROR_CODES,
  ContractError,
  fromErrorPayload,
  isContractError,
  toErrorPayload,
  type BuiltinErrorCode,
  type ErrorPayload,
} from './errors';

export {
  createClient,
  type ApiOf,
  type Client,
  type ClientHelpers,
  type ClientMethod,
  type ClientOptions,
} from './client';

export {
  implement,
  type CallerContext,
  type CallInfo,
  type EventPublisher,
  type HandlerContext,
  type HandlerFor,
  type Handlers,
  type ImplementOptions,
  type InvokeOptions,
  type Middleware,
  type Router,
  type RouterEvents,
  type ValidationOptions,
} from './router';

export { PushStream, type ContractStream } from './stream';

export type { CallOptions, ClientTransport, ContractLogger, ServerTransport } from './transport';

export {
  clientFrameSchema,
  findUnserializable,
  isSerializable,
  PROTOCOL_VERSION,
  serverFrameSchema,
  type AbortFrame,
  type ChunkFrame,
  type ClientFrame,
  type EndFrame,
  type ErrorFrame,
  type EventFrame,
  type RequestFrame,
  type RequestKind,
  type ResultFrame,
  type ServerFrame,
  type SubscribeFrame,
} from './protocol';

export { createServerSession, type ServerSession, type ServerSessionOptions } from './server';

export {
  createFrameClientTransport,
  type ClientFramePort,
  type FrameClientOptions,
  type FrameClientTransport,
} from './frameClient';

export {
  createIpcClientTransport,
  createIpcServerTransport,
  DEFAULT_MAX_SESSIONS_PER_SENDER,
  IPC_FRAME_CHANNEL,
  IPC_REQUEST_CHANNEL,
  type IpcBridgeLike,
  type IpcClientOptions,
  type IpcEnvelope,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type IpcServerOptions,
  type IpcServerTransport,
} from './ipc';
