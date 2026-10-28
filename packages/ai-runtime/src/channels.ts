/**
 * IPC 通道白名单 —— 反射挂通道时用的**唯一真相**。
 *
 * 通道形态：`ai:<facade>:<method>`。方法名与 `AIClient[facade][method]` 严格一致；
 * 每条 entry 还标明返回类型（`return | stream | void-emit`）供 IPCTransportServer 分派。
 *
 * 之所以显式列表而非纯反射整个 Facade：
 * - Facade 里可能夹带非 IPC-safe 字段（如 `on` 的回调，或者 subscribe 返回的 unsubscribe fn），
 *   直接反射会把它们也挂到通道，安全 & 语义都不对；
 * - 显式列表天然当**契约快照**（P6 计划 §测试策略：IPC 通道快照锁）。
 */

export type IpcMethodKind = 'return' | 'stream' | 'sync-return';

export interface IpcMethodSpec {
  facade: string;
  method: string;
  kind: IpcMethodKind;
  /** 是否危险（例如工具确认 / 存储写），供白名单窗口过滤时使用 */
  dangerous?: boolean;
}

export const IPC_PREFIX = 'ai' as const;

export function channelName(spec: Pick<IpcMethodSpec, 'facade' | 'method'>): string {
  return `${IPC_PREFIX}:${spec.facade}:${spec.method}`;
}

export function chunkChannelName(spec: Pick<IpcMethodSpec, 'facade' | 'method'>): string {
  return `${channelName(spec)}:chunk`;
}

export const IPC_METHODS: readonly IpcMethodSpec[] = Object.freeze([
  // chat
  { facade: 'chat', method: 'sendMessage', kind: 'return' },
  { facade: 'chat', method: 'stream', kind: 'stream' },
  { facade: 'chat', method: 'abort', kind: 'sync-return' },
  { facade: 'chat', method: 'regenerate', kind: 'stream' },
  // 工具循环（AI SDK withTools）：对话窗口用它让模型调用桌面 / 看板娘工具
  { facade: 'chat', method: 'agentStream', kind: 'stream' },

  // sessions
  { facade: 'sessions', method: 'list', kind: 'sync-return' },
  { facade: 'sessions', method: 'get', kind: 'sync-return' },
  { facade: 'sessions', method: 'create', kind: 'sync-return' },
  { facade: 'sessions', method: 'fork', kind: 'sync-return' },
  { facade: 'sessions', method: 'rename', kind: 'sync-return' },
  { facade: 'sessions', method: 'delete', kind: 'sync-return' },

  // tools
  { facade: 'tools', method: 'list', kind: 'sync-return' },
  { facade: 'tools', method: 'setEnabled', kind: 'sync-return' },
  { facade: 'tools', method: 'confirm', kind: 'sync-return', dangerous: true },

  // memory.userProfile
  { facade: 'userProfile', method: 'get', kind: 'sync-return' },
  { facade: 'userProfile', method: 'set', kind: 'return' },
  { facade: 'userProfile', method: 'reset', kind: 'return' },
  { facade: 'userProfile', method: 'export', kind: 'return' },
  { facade: 'userProfile', method: 'import', kind: 'return' },

  // memory.facts
  { facade: 'facts', method: 'list', kind: 'sync-return' },
  { facade: 'facts', method: 'put', kind: 'sync-return' },
  { facade: 'facts', method: 'delete', kind: 'sync-return' },

  // memory.summaries
  { facade: 'summaries', method: 'get', kind: 'sync-return' },
  { facade: 'summaries', method: 'put', kind: 'sync-return' },

  // asr
  { facade: 'asr', method: 'list', kind: 'sync-return' },
  { facade: 'asr', method: 'transcribe', kind: 'return' },

  // tts
  { facade: 'tts', method: 'list', kind: 'sync-return' },
  { facade: 'tts', method: 'listVoices', kind: 'return' },
  { facade: 'tts', method: 'synth', kind: 'return' },
  { facade: 'tts', method: 'stream', kind: 'stream' },
  { facade: 'tts', method: 'stop', kind: 'sync-return' },

  // avatar
  { facade: 'avatar', method: 'isAvailable', kind: 'sync-return' },
  { facade: 'avatar', method: 'playMotion', kind: 'return' },
  { facade: 'avatar', method: 'setExpression', kind: 'return' },
  { facade: 'avatar', method: 'driveLipSync', kind: 'sync-return' },
]);
