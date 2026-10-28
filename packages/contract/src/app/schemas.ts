/**
 * AI 门面的 DTO schema（docs/design/core-host-decoupling.md §4.2）。
 *
 * 逐项对照 `@nomi-ai/ai-sdk` 的 `types/`、`facade/` 与 `bundle-ig-base` / `bundle-ig-electron-caps`
 * 的 seam 类型手写：契约包只依赖 zod，不 import 运行时包。两边是否一致由 ai-runtime 的
 * `implement(appContract, …)` 在编译期检查（处理函数的入参 / 返回值类型由这里推导）。
 *
 * 约定：
 * - 只用 JSON 值与 `Uint8Array`（§4.2）；`AbortSignal`、`raw` 这类不可序列化字段不进契约；
 * - 视图传来的对象（对话选项、画像补丁）用 loose：未知字段原样透传，与原 IPC 行为一致；
 * - 不用 transform：两端都会解析一次；
 * - 输入严格、输出宽容：从磁盘读出的持久化数据（画像、事实、偏好、会话 meta）可能来自旧版本或被手改，
 *   输出 schema 里的枚举用 `storedEnum` 放行未知字符串，不让一个旧值让整次调用失败；
 *   视图写进来的同类字段（`MemoryFact`、`ProfilePatch`、`CreateSessionInput`）仍按枚举严格校验。
 */

import { z } from 'zod';

/** 二进制：Electron IPC 与 structuredClone 都保留 Uint8Array（Node 的 Buffer 也是它的子类） */
export const Bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
  message: 'Expected Uint8Array',
});

/**
 * 持久化数据里的枚举（只用于输出）：已知值照常通过，旧版本 / 手改留下的其他字符串也放行。
 * 类型保留已知值的提示，但消费方必须能处理未知值。
 */
const storedEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string()]) as unknown as z.ZodType<T[number] | (string & {})>;

// ---------------------------------------------------------------------------
// chat（bundle-ig-base types/common.ts、ai-sdk facade/ChatFacade.ts）
// ---------------------------------------------------------------------------

export const ChatRole = z.enum(['system', 'user', 'assistant', 'tool']);

export const ChatMessage = z.looseObject({
  role: ChatRole,
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  /** 用户消息附带的图片（base64，不含 data: 前缀） */
  images: z.array(z.object({ mime: z.string(), data: z.string() })).optional(),
});

export const LLMRole = z.enum(['chat', 'agent-tools', 'summary']);

export const ContextBudget = z.object({
  maxTokens: z.number().optional(),
  maxMessages: z.number().optional(),
});

/** `ChatStreamOptions` 去掉 `signal`（取消走契约的 abort） */
export const ChatOptions = z.looseObject({
  reqId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  messages: z.array(ChatMessage),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  context: z.union([ContextBudget, z.literal(false)]).optional(),
  maxSteps: z.number().optional(),
  role: LLMRole.optional(),
});

export const FinishReason = z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'error']);

export const ChatUsage = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  contextTokens: z.number().optional(),
  redacted: z.number().optional(),
});

/** `ChatResponse` 去掉 `raw`（上游原始响应，不保证可序列化，视图也不用） */
export const ChatResponse = z.object({
  reqId: z.string(),
  provider: z.string(),
  model: z.string(),
  content: z.string(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), argumentsJson: z.string() }))
    .optional(),
  finishReason: FinishReason,
  usage: ChatUsage.optional(),
});

export const ChatChunk = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('delta'), content: z.string() }),
  z.looseObject({
    type: z.literal('tool_call.delta'),
    index: z.number(),
    name: z.string().optional(),
    argumentsJson: z.string().optional(),
    id: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('tool_call.result'),
    id: z.string(),
    name: z.string(),
    output: z.string().optional(),
    error: z.string().optional(),
  }),
  z.looseObject({ type: z.literal('reasoning'), content: z.string() }),
  z.looseObject({ type: z.literal('usage'), usage: ChatUsage, model: z.string().optional() }),
  z.looseObject({ type: z.literal('done'), finishReason: FinishReason }),
  z.looseObject({ type: z.literal('error'), error: z.string() }),
]);

// ---------------------------------------------------------------------------
// sessions（ai-sdk types/Session.ts、facade/SessionFacade.ts）
// ---------------------------------------------------------------------------

export const SessionMeta = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  agentPreset: z.string().optional(),
  meta: SessionMeta.optional(),
});

/** 输出用：读自磁盘的会话 meta 可能有旧版本 / 手改的值，原样返回 */
export const StoredSession = Session.extend({
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const CreateSessionInput = z.object({
  title: z.string().optional(),
  agentPreset: z.string().optional(),
  meta: SessionMeta.optional(),
});

// ---------------------------------------------------------------------------
// tools（ai-sdk types/ToolSpec.ts）
// ---------------------------------------------------------------------------

export const ToolSpec = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON Schema（IPC-safe） */
  parametersJsonSchema: z.unknown(),
  dangerous: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const ToolConfirmRequest = z.object({
  reqId: z.string(),
  toolName: z.string(),
  argumentsJson: z.string(),
  reason: z.string().optional(),
  createdAt: z.number(),
});

// ---------------------------------------------------------------------------
// memory（ai-sdk types/MemoryFact.ts、bundle-ig-base types/UserProfile.ts）
// ---------------------------------------------------------------------------

const FACT_KINDS = ['preference', 'identity', 'goal', 'dislike', 'habit', 'note'] as const;
const FACT_SOURCES = ['user', 'inferred', 'distilled', 'system'] as const;

/** 输入：视图写入的事实，枚举严格校验 */
export const MemoryFact = z.object({
  id: z.string(),
  kind: z.enum(FACT_KINDS),
  text: z.string(),
  source: z.enum(FACT_SOURCES),
  at: z.number(),
  confidence: z.number().optional(),
});

/** 输出：读自磁盘的事实，旧版本 / 手改的 kind、source 原样返回 */
export const StoredMemoryFact = MemoryFact.extend({
  kind: storedEnum(FACT_KINDS),
  source: storedEnum(FACT_SOURCES),
});

export const SessionSummary = z.object({
  sessionId: z.string(),
  summary: z.string(),
  updatedAt: z.number(),
  stepCount: z.number(),
});

const PREFERENCE_SOURCES = ['user', 'inferred', 'distilled'] as const;
/** 输入（`ProfilePatch.source`）：严格 */
const PreferenceSource = z.enum(PREFERENCE_SOURCES);

/** 以下画像 schema 只用于输出（画像读自磁盘），枚举一律宽容，见文件头 */
const preferenceValue = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    source: storedEnum(PREFERENCE_SOURCES),
    updatedAt: z.number(),
    confidence: z.number().optional(),
  });

export const UserIdentity = z.object({
  displayName: z.string().optional(),
  nickname: z.string().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
});

export const CodeStylePreference = z.object({
  language: z.array(z.string()).optional(),
  framework: z.array(z.string()).optional(),
  indent: z
    .union([z.literal('tab'), z.literal(2), z.literal(4), z.string(), z.number()])
    .optional(),
  quotes: storedEnum(['single', 'double']).optional(),
  packageManager: storedEnum(['npm', 'pnpm', 'yarn', 'bun']).optional(),
  comments: storedEnum(['minimal', 'verbose']).optional(),
});

export const UserPreferences = z.object({
  replyLanguage: preferenceValue(z.string()).optional(),
  replyStyle: preferenceValue(storedEnum(['concise', 'detailed', 'bullet', 'stepwise'])).optional(),
  tone: preferenceValue(storedEnum(['formal', 'casual', 'cute', 'strict'])).optional(),
  codeStyle: CodeStylePreference.optional(),
  ttsVoiceId: preferenceValue(z.string()).optional(),
  autoAcceptTools: z.array(z.string()).optional(),
  privacy: z
    .object({
      allowScreenCapture: z.boolean().optional(),
      allowClipboardRead: z.boolean().optional(),
      allowFileWrite: z.boolean().optional(),
    })
    .optional(),
});

export const UserHabits = z.object({
  activeHours: z.array(z.number()).optional(),
  avgSessionLen: z.number().optional(),
  stopGenerationRate: z.number().optional(),
  regenRate: z.number().optional(),
  topTools: z.array(z.object({ tool: z.string(), count: z.number() })).optional(),
  topTopics: z.array(z.object({ topic: z.string(), count: z.number() })).optional(),
  updatedAt: z.number().optional(),
});

/** 画像：顶层 loose，视图写进去的额外字段（如对话设置）原样返回 */
export const UserProfile = z.looseObject({
  version: z.number(),
  identity: UserIdentity,
  preferences: UserPreferences,
  habits: UserHabits,
  dislikes: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** `ProfilePatch`：`patch` 是 DeepPartial<UserProfile>，按原样透传给画像服务校验与合并 */
export const ProfilePatch = z.object({
  patch: z.record(z.string(), z.unknown()),
  source: PreferenceSource,
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// asr / tts（bundle-ig-electron-caps seams/asr.ts、seams/tts.ts）
// ---------------------------------------------------------------------------

export const AsrProviderInfo = z.object({
  id: z.string(),
  name: z.string(),
  streaming: z.boolean(),
  requiresApiKey: z.boolean(),
  supportedLanguages: z.array(z.string()).optional(),
});

export const PcmChunk = z.object({
  sampleRate: z.literal(16000),
  bitDepth: z.literal(16),
  channels: z.literal(1),
  data: Bytes,
});

/** `AsrOptions` 去掉 `signal` */
export const AsrOptions = z.object({
  providerId: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().optional(),
});

/** `AsrResult` 去掉 `raw` */
export const AsrResult = z.object({
  providerId: z.string(),
  text: z.string(),
  language: z.string().optional(),
  durationMs: z.number().optional(),
  confidence: z.number().optional(),
});

export const TtsVoice = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string(),
  language: z.string(),
  gender: z.enum(['male', 'female', 'unknown']).optional(),
});

export const TtsProviderInfo = z.object({
  id: z.string(),
  name: z.string(),
  streaming: z.boolean(),
  requiresApiKey: z.boolean(),
});

/** `TtsOptions` 去掉 `signal` */
export const TtsOptions = z.object({
  providerId: z.string().optional(),
  voiceId: z.string().optional(),
  language: z.string().optional(),
  rate: z.number().optional(),
  pitch: z.number().optional(),
  volume: z.number().optional(),
  format: z.enum(['mp3', 'wav', 'ogg']).optional(),
  reqId: z.string().optional(),
});

export const TtsChunk = z.object({
  reqId: z.string(),
  seq: z.number(),
  mime: z.string(),
  data: Bytes,
  rms: z.number().optional(),
  atMs: z.number().optional(),
  isFinal: z.boolean().optional(),
});

export const TtsResult = z.object({
  reqId: z.string(),
  providerId: z.string(),
  voiceId: z.string().optional(),
  mime: z.string(),
  data: Bytes,
  durationMs: z.number().optional(),
});

// ---------------------------------------------------------------------------
// avatar（AI ⇄ 角色只传语义事件，docs/design/core-host-decoupling.md §10.5）
// 词表在 @nomi-ai/character-contract（SEMANTIC_*）；契约不依赖它，只要求名字是语义名的形状
// （驼峰，没有下划线 / 连字符），角色包的资源名（`thumbs_up`、`think-on`）过不了线。
// ---------------------------------------------------------------------------

export const AvatarSemanticName = z
  .string()
  .regex(/^[a-z][a-zA-Z]{0,31}$/, 'semantic name (camelCase), not a clip / motion id');

export const AvatarEmotionInput = z.object({
  name: AvatarSemanticName,
  /** 强度 0..1，缺省 1 */
  weight: z.number().min(0).max(1).optional(),
});
export const AvatarGestureInput = z.object({ name: AvatarSemanticName });
export const AvatarActivityInput = z.object({ name: AvatarSemanticName });
/** 说话的口型包络 0..1（0 = 停止） */
export const AvatarSpeakingInput = z.object({ level: z.number().min(0).max(1) });

/** 内核 → 角色窗口：情绪 / 手势 / 活动，以及对话窗口的「正在等回复」 */
export const AvatarCue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('emotion'), ...AvatarEmotionInput.shape }),
  z.object({ type: z.literal('gesture'), ...AvatarGestureInput.shape }),
  z.object({ type: z.literal('activity'), ...AvatarActivityInput.shape }),
  z.object({ type: z.literal('reply'), phase: z.enum(['waiting', 'settled']) }),
]);

/** 角色身上的命中区（契约命中区名，any = 没有落在具体区域） */
export const AvatarHitbox = z.enum(['head', 'face', 'body', 'hand', 'hem', 'legs', 'any']);

/** 角色 → AI：被摸、被点、当前场景（角色与它能表现的语义名） */
export const AvatarReport = z.discriminatedUnion('type', [
  z.object({ type: z.literal('touched'), hitbox: AvatarHitbox }),
  z.object({ type: z.literal('clicked'), hitbox: AvatarHitbox, double: z.boolean().optional() }),
  z.object({
    type: z.literal('scene'),
    characterId: z.string().min(1).max(64),
    emotions: z.array(AvatarSemanticName).max(64),
    activities: z.array(AvatarSemanticName).max(64),
    gestures: z.array(AvatarSemanticName).max(128),
  }),
]);
