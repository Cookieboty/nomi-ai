/**
 * AI 门面的过程与事件（docs/design/core-host-decoupling.md §4.1、§12 P1）。
 *
 * 取代 `ai-runtime/src/channels.ts` 与 `ai-sdk-client/src/channels.ts` 两份 `IPC_METHODS`：
 * - 过程名 `ai.<facade>.<method>`，memory 子域写全（`ai.memory.userProfile.get`）；
 * - 原 `kind: 'sync-return' | 'return'` → 读用 query、写用 mutation（一律异步，§4.2），
 *   `'stream'` → stream；`dangerous` 原样保留；
 * - 门面方法的位置参数在契约里变成具名对象（`AI_METHODS[*].params`），视图侧的
 *   `ClientAIClient` 按这张表把 `(reqId, ok, reason)` 打包成 `{ reqId, ok, reason }`；
 * - `ai:event` 的 12 个业务事件变成契约事件 `ai.<domain>.<name>`（`AI_EVENTS`）。
 */

import { z } from 'zod';

import {
  AsrOptions,
  Bytes,
  AsrProviderInfo,
  AsrResult,
  AvatarActivityInput,
  AvatarEmotionInput,
  AvatarGestureInput,
  AvatarReport,
  AvatarSpeakingInput,
  ChatChunk,
  ChatOptions,
  ChatResponse,
  CreateSessionInput,
  MemoryFact,
  PcmChunk,
  ProfilePatch,
  SessionSummary,
  StoredMemoryFact,
  StoredSession,
  ToolSpec,
  TtsChunk,
  TtsOptions,
  TtsProviderInfo,
  TtsResult,
  TtsVoice,
  UserProfile,
} from './schemas';

const id = z.object({ id: z.string() });

export const aiProcedures = {
  // chat
  'ai.chat.sendMessage': { kind: 'mutation', input: ChatOptions, output: ChatResponse },
  'ai.chat.stream': { kind: 'stream', input: ChatOptions, chunk: ChatChunk },
  'ai.chat.abort': { kind: 'mutation', input: z.object({ reqId: z.string() }), output: z.void() },
  'ai.chat.regenerate': { kind: 'stream', input: ChatOptions, chunk: ChatChunk },
  /** 工具循环（AI SDK withTools）：对话窗口用它让模型调用桌面 / 看板娘工具 */
  'ai.chat.agentStream': { kind: 'stream', input: ChatOptions, chunk: ChatChunk },

  // sessions
  'ai.sessions.list': { kind: 'query', input: z.void(), output: z.array(StoredSession) },
  'ai.sessions.get': { kind: 'query', input: id, output: StoredSession.optional() },
  'ai.sessions.create': {
    kind: 'mutation',
    input: CreateSessionInput.optional(),
    output: StoredSession,
  },
  'ai.sessions.fork': {
    kind: 'mutation',
    input: z.object({ id: z.string(), overrides: CreateSessionInput.optional() }),
    output: StoredSession,
  },
  'ai.sessions.rename': {
    kind: 'mutation',
    input: z.object({ id: z.string(), title: z.string() }),
    output: StoredSession,
  },
  'ai.sessions.delete': { kind: 'mutation', input: id, output: z.boolean() },

  // tools
  'ai.tools.list': { kind: 'query', input: z.void(), output: z.array(ToolSpec) },
  'ai.tools.setEnabled': {
    kind: 'mutation',
    input: z.object({ name: z.string(), enabled: z.boolean() }),
    output: z.void(),
  },
  'ai.tools.confirm': {
    kind: 'mutation',
    input: z.object({ reqId: z.string(), ok: z.boolean(), reason: z.string().optional() }),
    output: z.void(),
    dangerous: true,
  },

  // memory.userProfile
  'ai.memory.userProfile.get': { kind: 'query', input: z.void(), output: UserProfile },
  'ai.memory.userProfile.set': { kind: 'mutation', input: ProfilePatch, output: UserProfile },
  'ai.memory.userProfile.reset': { kind: 'mutation', input: z.void(), output: UserProfile },
  'ai.memory.userProfile.export': { kind: 'query', input: z.void(), output: UserProfile },
  'ai.memory.userProfile.import': {
    kind: 'mutation',
    input: z.object({ data: z.unknown() }),
    output: UserProfile,
  },

  // memory.facts
  'ai.memory.facts.list': { kind: 'query', input: z.void(), output: z.array(StoredMemoryFact) },
  'ai.memory.facts.put': { kind: 'mutation', input: MemoryFact, output: StoredMemoryFact },
  'ai.memory.facts.delete': { kind: 'mutation', input: id, output: z.boolean() },

  // memory.summaries
  'ai.memory.summaries.get': {
    kind: 'query',
    input: z.object({ sessionId: z.string() }),
    output: SessionSummary.optional(),
  },
  'ai.memory.summaries.put': { kind: 'mutation', input: SessionSummary, output: SessionSummary },

  // asr
  'ai.asr.list': { kind: 'query', input: z.void(), output: z.array(AsrProviderInfo) },
  'ai.asr.transcribe': {
    kind: 'mutation',
    input: z.object({ pcm: PcmChunk, opts: AsrOptions.optional() }),
    output: AsrResult,
  },

  // tts
  'ai.tts.list': { kind: 'query', input: z.void(), output: z.array(TtsProviderInfo) },
  'ai.tts.listVoices': { kind: 'query', input: z.void(), output: z.array(TtsVoice) },
  'ai.tts.synth': {
    kind: 'mutation',
    input: z.object({ text: z.string(), opts: TtsOptions.optional() }),
    output: TtsResult,
  },
  'ai.tts.stream': {
    kind: 'stream',
    input: z.object({ text: z.string(), opts: TtsOptions.optional() }),
    chunk: TtsChunk,
  },
  'ai.tts.stop': { kind: 'mutation', input: z.object({ reqId: z.string() }), output: z.void() },

  // avatar（只有语义名，§10.5）
  'ai.avatar.isAvailable': { kind: 'query', input: z.void(), output: z.boolean() },
  'ai.avatar.emotion': { kind: 'mutation', input: AvatarEmotionInput, output: z.void() },
  'ai.avatar.gesture': { kind: 'mutation', input: AvatarGestureInput, output: z.void() },
  'ai.avatar.activity': { kind: 'mutation', input: AvatarActivityInput, output: z.void() },
  'ai.avatar.speaking': { kind: 'mutation', input: AvatarSpeakingInput, output: z.void() },
  /** 角色 → AI：角色窗口报告被摸 / 被点 / 场景，经 AI 插件宿主的 ctx.avatar 转给订阅者 */
  'ai.avatar.report': { kind: 'mutation', input: AvatarReport, output: z.void() },
} as const;

export type AiProcedureName = keyof typeof aiProcedures;

// ---------------------------------------------------------------------------
// 门面方法 ↔ 过程（视图侧 ClientAIClient 用它保持 AIClient 的位置参数签名）
// ---------------------------------------------------------------------------

/** 门面路径：与 `AIClient` 的属性一致（memory 子域带前缀） */
export type AiFacadePath =
  | 'chat'
  | 'sessions'
  | 'tools'
  | 'memory.userProfile'
  | 'memory.facts'
  | 'memory.summaries'
  | 'asr'
  | 'tts'
  | 'avatar';

export interface AiMethodSpec {
  facade: AiFacadePath;
  method: string;
  procedure: AiProcedureName;
  /**
   * 位置参数 → 过程入参：
   * - `'value'`：唯一的参数原样作为入参（选项对象、DTO）；
   * - 字符串数组：第 i 个参数放到入参的第 i 个字段（`[]` = 无参数）。
   */
  params: 'value' | readonly string[];
}

const m = (facade: AiFacadePath, method: string, params: AiMethodSpec['params']): AiMethodSpec => ({
  facade,
  method,
  procedure: `ai.${facade}.${method}` as AiProcedureName,
  params,
});

export const AI_METHODS: readonly AiMethodSpec[] = Object.freeze([
  m('chat', 'sendMessage', 'value'),
  m('chat', 'stream', 'value'),
  m('chat', 'abort', ['reqId']),
  m('chat', 'regenerate', 'value'),
  m('chat', 'agentStream', 'value'),
  m('sessions', 'list', []),
  m('sessions', 'get', ['id']),
  m('sessions', 'create', 'value'),
  m('sessions', 'fork', ['id', 'overrides']),
  m('sessions', 'rename', ['id', 'title']),
  m('sessions', 'delete', ['id']),
  m('tools', 'list', []),
  m('tools', 'setEnabled', ['name', 'enabled']),
  m('tools', 'confirm', ['reqId', 'ok', 'reason']),
  m('memory.userProfile', 'get', []),
  m('memory.userProfile', 'set', 'value'),
  m('memory.userProfile', 'reset', []),
  m('memory.userProfile', 'export', []),
  m('memory.userProfile', 'import', ['data']),
  m('memory.facts', 'list', []),
  m('memory.facts', 'put', 'value'),
  m('memory.facts', 'delete', ['id']),
  m('memory.summaries', 'get', ['sessionId']),
  m('memory.summaries', 'put', 'value'),
  m('asr', 'list', []),
  m('asr', 'transcribe', ['pcm', 'opts']),
  m('tts', 'list', []),
  m('tts', 'listVoices', []),
  m('tts', 'synth', ['text', 'opts']),
  m('tts', 'stream', ['text', 'opts']),
  m('tts', 'stop', ['reqId']),
  m('avatar', 'isAvailable', []),
  m('avatar', 'emotion', ['name', 'weight']),
  m('avatar', 'gesture', ['name']),
  m('avatar', 'activity', ['name']),
  m('avatar', 'speaking', ['level']),
  m('avatar', 'report', 'value'),
]);

/** 位置参数 → 过程入参（undefined 字段不写入，保持可序列化且不污染可选字段） */
export function aiArgsToInput(spec: AiMethodSpec, args: readonly unknown[]): unknown {
  if (spec.params === 'value') return args[0];
  if (spec.params.length === 0) return undefined;
  const input: Record<string, unknown> = {};
  spec.params.forEach((name, i) => {
    if (args[i] !== undefined) input[name] = args[i];
  });
  return input;
}

// ---------------------------------------------------------------------------
// 事件（原 `ai:event` 的 `{ evt, data }`）
// ---------------------------------------------------------------------------

/**
 * 事件 payload 来自插件事件总线，形状没有运行时保证（例如 GuardrailsPlugin 的确认事件、
 * 画像变更事件都与声明的类型不完全一致），所以事件 schema 有意放宽：只要求是对象，
 * 已知字段写明类型但都可缺省，未知字段原样透传。旧的 `ai:event` 广播同样不做校验。
 */
const loose = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape).partial();

export const aiEvents = {
  'ai.message.delta': loose({
    sessionId: z.string(),
    messageId: z.string(),
    deltaText: z.string(),
    part: z.unknown(),
  }),
  'ai.message.complete': loose({ message: z.unknown() }),
  'ai.agent.step': loose({
    sessionId: z.string(),
    step: z.number(),
    reason: z.string(),
  }),
  'ai.agent.turnEnd': loose({
    sessionId: z.string(),
    turnId: z.string(),
    ok: z.boolean(),
    reason: z.string(),
  }),
  'ai.agent.stoppedByUser': loose({ sessionId: z.string(), reqId: z.string() }),
  'ai.tool.confirmRequired': loose({
    reqId: z.string(),
    toolName: z.string(),
    argumentsJson: z.string(),
    reason: z.string(),
    createdAt: z.number(),
  }),
  'ai.tool.executed': loose({
    toolName: z.string(),
    reqId: z.string(),
    ok: z.boolean(),
    durationMs: z.number(),
    error: z.string(),
  }),
  'ai.tts.chunk': loose({
    reqId: z.string(),
    seq: z.number(),
    mime: z.string(),
    data: Bytes,
    rms: z.number(),
    atMs: z.number(),
    isFinal: z.boolean(),
  }),
  'ai.tts.end': loose({ reqId: z.string(), ok: z.boolean(), durationMs: z.number() }),
  'ai.userProfile.changed': loose({ profile: z.unknown() }),
  'ai.avatar.touched': loose({ hitbox: z.string(), at: z.number() }),
  'ai.avatar.clicked': loose({ hitbox: z.string(), double: z.boolean(), at: z.number() }),
  'ai.avatar.scene': loose({
    characterId: z.string(),
    emotions: z.array(z.string()),
    activities: z.array(z.string()),
    gestures: z.array(z.string()),
    at: z.number(),
  }),
} as const;

export type AiContractEvent = keyof typeof aiEvents;

/** `AIClient.on(evt)` 的事件名 → 契约事件名（与 ai-sdk `AIClientEvent` 一一对应） */
export const AI_EVENTS = Object.freeze({
  'message:delta': 'ai.message.delta',
  'message:complete': 'ai.message.complete',
  'agent:step': 'ai.agent.step',
  'agent:turn-end': 'ai.agent.turnEnd',
  'agent:stopped-by-user': 'ai.agent.stoppedByUser',
  'tool:confirm-required': 'ai.tool.confirmRequired',
  'tool:executed': 'ai.tool.executed',
  'tts:chunk': 'ai.tts.chunk',
  'tts:end': 'ai.tts.end',
  'userProfile:changed': 'ai.userProfile.changed',
  'avatar:touched': 'ai.avatar.touched',
  'avatar:clicked': 'ai.avatar.clicked',
  'avatar:scene': 'ai.avatar.scene',
} as const satisfies Record<string, AiContractEvent>);

export type AiClientEventName = keyof typeof AI_EVENTS;
