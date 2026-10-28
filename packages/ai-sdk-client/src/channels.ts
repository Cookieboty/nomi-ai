/**
 * IPC 通道表（渲染进程视角）—— 与 [`@nomi-ai/ai-runtime/channels`](file:///../../ai-runtime/src/channels.ts)
 * 保持结构一致，但**在渲染端独立维护**，避免让浏览器打包器把 `ai-runtime`
 * 的 electron 主进程代码拉进来。
 *
 * 契约：
 * - 顺序、字段与 runtime 侧一致；任何一方变更必须双向同步；
 * - `channels.snapshot.test.ts` 会跨包做结构对齐断言，防止漂移。
 */

export type IpcMethodKind = 'return' | 'stream' | 'sync-return';

export interface IpcMethodSpec {
  facade: string;
  method: string;
  kind: IpcMethodKind;
  dangerous?: boolean;
}

export const IPC_PREFIX = 'ai' as const;

export function channelName(spec: Pick<IpcMethodSpec, 'facade' | 'method'>): string {
  return `${IPC_PREFIX}:${spec.facade}:${spec.method}`;
}

export function chunkChannelName(spec: Pick<IpcMethodSpec, 'facade' | 'method'>): string {
  return `${channelName(spec)}:chunk`;
}

export const AI_EVENT_CHANNEL = `${IPC_PREFIX}:event` as const;

export const IPC_METHODS: readonly IpcMethodSpec[] = Object.freeze([
  { facade: 'chat', method: 'sendMessage', kind: 'return' },
  { facade: 'chat', method: 'stream', kind: 'stream' },
  { facade: 'chat', method: 'abort', kind: 'sync-return' },
  { facade: 'chat', method: 'regenerate', kind: 'stream' },
  // 工具循环（AI SDK withTools）：对话窗口用它让模型调用桌面 / 看板娘工具
  { facade: 'chat', method: 'agentStream', kind: 'stream' },

  { facade: 'sessions', method: 'list', kind: 'sync-return' },
  { facade: 'sessions', method: 'get', kind: 'sync-return' },
  { facade: 'sessions', method: 'create', kind: 'sync-return' },
  { facade: 'sessions', method: 'fork', kind: 'sync-return' },
  { facade: 'sessions', method: 'rename', kind: 'sync-return' },
  { facade: 'sessions', method: 'delete', kind: 'sync-return' },

  { facade: 'tools', method: 'list', kind: 'sync-return' },
  { facade: 'tools', method: 'setEnabled', kind: 'sync-return' },
  { facade: 'tools', method: 'confirm', kind: 'sync-return', dangerous: true },

  { facade: 'userProfile', method: 'get', kind: 'sync-return' },
  { facade: 'userProfile', method: 'set', kind: 'return' },
  { facade: 'userProfile', method: 'reset', kind: 'return' },
  { facade: 'userProfile', method: 'export', kind: 'return' },
  { facade: 'userProfile', method: 'import', kind: 'return' },

  { facade: 'facts', method: 'list', kind: 'sync-return' },
  { facade: 'facts', method: 'put', kind: 'sync-return' },
  { facade: 'facts', method: 'delete', kind: 'sync-return' },

  { facade: 'summaries', method: 'get', kind: 'sync-return' },
  { facade: 'summaries', method: 'put', kind: 'sync-return' },

  { facade: 'asr', method: 'list', kind: 'sync-return' },
  { facade: 'asr', method: 'transcribe', kind: 'return' },

  { facade: 'tts', method: 'list', kind: 'sync-return' },
  { facade: 'tts', method: 'listVoices', kind: 'return' },
  { facade: 'tts', method: 'synth', kind: 'return' },
  { facade: 'tts', method: 'stream', kind: 'stream' },
  { facade: 'tts', method: 'stop', kind: 'sync-return' },

  { facade: 'avatar', method: 'isAvailable', kind: 'sync-return' },
  { facade: 'avatar', method: 'playMotion', kind: 'return' },
  { facade: 'avatar', method: 'setExpression', kind: 'return' },
  { facade: 'avatar', method: 'driveLipSync', kind: 'sync-return' },
]);

/**
 * 反向索引：`facade.method` → spec；便于 ClientAIClient Proxy 快速判定 kind。
 */
export const IPC_METHOD_INDEX: ReadonlyMap<string, IpcMethodSpec> = new Map(
  IPC_METHODS.map((s) => [`${s.facade}.${s.method}`, s]),
);
