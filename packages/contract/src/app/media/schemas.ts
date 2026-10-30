/**
 * D1 · 语音 / 朗读 / 桌面能力 / 屏幕的 DTO schema（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 照现有类型手写（契约包只依赖 zod）：
 * - 语音：electron `voice/VoiceService.ts`、`voice/settings.ts`；视图 `@nomi-ai/voice` 的 `bridge.ts`；
 * - 朗读：`@nomi-ai/types` 的 `TTSConfig` / `TTSSpeakResult` / `TTSTestResult` / `TTSStatus`；
 * - 桌面能力：electron `desktop/*`（`PermissionBroker`、`AuditLog`、`UndoJournal`、`ReminderStore`）、
 *   `@nomi-ai/types` 的 `DesktopConfirmRequest` / `DesktopBubble` / `DesktopReminderEvent`。
 *
 * 约定同 AI 门面：只用 JSON 值与 `Uint8Array`；字段多、会演进的返回值与事件用 looseObject（未知字段透传）；
 * 从磁盘读出的枚举（审计、提醒状态）用宽松的 storedEnum。
 */

import { z } from 'zod';

import { Bytes } from '../schemas';

const storedEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string()]) as unknown as z.ZodType<T[number] | (string & {})>;

// ---------------------------------------------------------------------------
// 语音输入（ai:voice:*）
// ---------------------------------------------------------------------------

export const AsrErrorCode = z.enum([
  'no_engine',
  'no_model',
  'no_provider',
  'cloud_not_acked',
  'local_only',
  'empty',
  'failed',
]);

export const VoiceSettings = z.looseObject({
  engine: storedEnum(['whisper-cpp', 'openai-compat', 'volc']),
  language: z.string(),
  whisperModel: z.string(),
  whisperCliPath: z.string(),
  providerId: z.string(),
  customBaseURL: z.string(),
  cloudModel: z.string(),
  volcResourceId: z.string(),
  volcFallback: z.boolean(),
  cloudAcked: z.array(z.string()),
  autoSend: z.boolean(),
  bargeIn: z.boolean(),
  vadThreshold: z.number(),
  wakeWord: z.looseObject({ enabled: z.boolean(), phrase: z.string(), windowSec: z.number() }),
});

/** 设置补丁：主进程 sanitize，未知字段透传给它处理 */
export const VoiceSettingsPatch = z.looseObject({
  engine: z.string().optional(),
  language: z.string().optional(),
  whisperModel: z.string().optional(),
  whisperCliPath: z.string().optional(),
  providerId: z.string().optional(),
  customBaseURL: z.string().optional(),
  cloudModel: z.string().optional(),
  volcResourceId: z.string().optional(),
  volcFallback: z.boolean().optional(),
  autoSend: z.boolean().optional(),
  bargeIn: z.boolean().optional(),
  vadThreshold: z.number().optional(),
  wakeWord: z
    .looseObject({
      enabled: z.boolean().optional(),
      phrase: z.string().optional(),
      windowSec: z.number().optional(),
    })
    .optional(),
});

export const VoiceAsset = z.looseObject({
  id: z.string(),
  kind: storedEnum(['whisper-bin', 'whisper-model', 'vad']),
  name: z.string(),
  description: z.string(),
  bytes: z.number(),
  license: z.string(),
  licenseUrl: z.string(),
  sourceUrl: z.string(),
  installed: z.boolean(),
  downloading: z.object({ received: z.number(), total: z.number() }).nullable(),
});

export const VoiceReadiness = z.looseObject({
  ok: z.boolean(),
  code: AsrErrorCode.optional(),
  message: z.string().optional(),
  local: z.boolean(),
});

export const VoiceState = z.looseObject({
  settings: VoiceSettings,
  platform: z.string(),
  assets: z.array(VoiceAsset),
  cli: z
    .looseObject({ path: z.string(), source: storedEnum(['downloaded', 'custom', 'path']) })
    .nullable(),
  readiness: VoiceReadiness,
  volc: z
    .looseObject({
      hasKey: z.boolean(),
      host: z.string(),
      resources: z.array(z.string()),
      canStoreKey: z.boolean(),
      fallbackReady: z.boolean(),
    })
    .optional(),
  vadReady: z.boolean(),
  providers: z.array(z.looseObject({ id: z.string(), name: z.string(), local: z.boolean() })),
  activity: z.string(),
});

export const VoiceOkResult = z.object({ ok: z.boolean(), error: z.string().optional() });

export const VoiceVadOpenResult = z.object({
  kind: z.enum(['silero', 'energy']),
  handle: z.string().optional(),
  error: z.string().optional(),
});

/** 识别结果（整段与流式结束共用） */
export const VoiceTranscribeResult = z.union([
  z.object({ ok: z.literal(true), text: z.string(), fallback: z.boolean().optional() }),
  z.object({ ok: z.literal(false), code: AsrErrorCode, error: z.string() }),
]);

export const VoiceTranscribeInput = z.object({
  /** 16kHz 单声道 PCM16 WAV */
  wav: Bytes,
  source: z.string().max(64).optional(),
  purpose: z.enum(['command', 'wake']).optional(),
});

/**
 * 流式识别（豆包 2.0）：`voice.streamStart` 的 chunk。
 * 第一条是 `start`（ok + id，或失败原因）；之后是这个会话的临时结果 `partial` 与中途错误 `error`。
 * 会话在 `voice.streamStop` / `voice.streamCancel` 之后结束。
 */
export const VoiceStreamChunk = z.union([
  z.object({ type: z.literal('start'), ok: z.literal(true), id: z.string() }),
  z.object({
    type: z.literal('start'),
    ok: z.literal(false),
    code: AsrErrorCode,
    error: z.string(),
  }),
  z.object({
    type: z.enum(['partial', 'error']),
    id: z.string(),
    text: z.string().optional(),
    code: AsrErrorCode.optional(),
    error: z.string().optional(),
  }),
]);

export const VoiceProgressEvent = z.looseObject({
  id: z.string(),
  received: z.number(),
  total: z.number(),
  phase: storedEnum(['start', 'progress', 'done', 'error', 'cancelled']),
  error: z.string().optional(),
});

export const VoiceActivityEvent = z.looseObject({ activity: z.string(), source: z.string() });

export const VoiceInjectEvent = z.looseObject({ text: z.string(), autoSend: z.boolean() });

/** 看板娘旧语音设置（config.json 的 voiceSettings：音量、整点报时、音效开关…） */
export const MascotVoiceSettings = z.looseObject({
  enabled: z.boolean().optional(),
  volume: z.number().optional(),
  timeAnnouncement: z.boolean().optional(),
  voicePackPath: z.string().optional(),
  voiceMode: z.string().optional(),
  sfxEnabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// 朗读（getTTSConfig / saveTTSConfig / tts:*）
// ---------------------------------------------------------------------------

export const TtsProvider = storedEnum(['none', 'edge', 'azure', 'openai']);

export const TtsConfig = z.looseObject({
  enabled: z.boolean(),
  promptVoice: z.boolean().optional(),
  provider: TtsProvider,
  edgeVoice: z.string().optional(),
  rate: z.number().optional(),
  readReplies: z.boolean().optional(),
  lastModified: z.number(),
});

/** 视图传入的配置（保存 / 测试）：主进程校验，未知字段透传 */
export const TtsConfigInput = z.looseObject({
  enabled: z.boolean().optional(),
  promptVoice: z.boolean().optional(),
  provider: z.string(),
  edgeVoice: z.string().optional(),
  rate: z.number().optional(),
  readReplies: z.boolean().optional(),
  lastModified: z.number().optional(),
});

export const TtsTestResult = z.looseObject({
  success: z.boolean(),
  message: z.string(),
  latency: z.number().optional(),
});

export const TtsSpeakResult = z.looseObject({
  success: z.boolean(),
  audioBase64: z.string().optional(),
  mimeType: z.string().optional(),
  via: TtsProvider.optional(),
  message: z.string().optional(),
});

export const TtsVoice = z.looseObject({
  shortName: z.string(),
  locale: z.string(),
  gender: z.string().optional(),
  name: z.string().optional(),
});

export const TtsVoiceList = z.looseObject({
  voices: z.array(TtsVoice),
  source: storedEnum(['online', 'builtin']),
});

export const TtsStatus = z.looseObject({
  consecutiveFailures: z.number(),
  lastFailureAt: z.number().optional(),
  lastSuccessAt: z.number().optional(),
});

export const TtsPreviewInput = z.object({
  text: z.string(),
  provider: z.string(),
  edgeVoice: z.string().optional(),
  rate: z.number().optional(),
});

export const TtsSpeakInput = z.object({ text: z.string(), volume: z.number().optional() });

/** 朗读 AI 回复：say / end / stop（主进程按配置决定是否转发给看板娘） */
export const TtsReplyInput = z.union([
  z.object({ op: z.literal('say'), id: z.string(), text: z.string() }),
  z.object({ op: z.literal('end'), id: z.string() }),
  z.object({ op: z.literal('stop'), id: z.string().optional() }),
]);

// ---------------------------------------------------------------------------
// 桌面能力（ai:desktop:*、desktop:*）
// ---------------------------------------------------------------------------

export const DesktopDanger = storedEnum(['read', 'write', 'destructive']);
export const DesktopPolicy = storedEnum(['always', 'session', 'ask']);

export const DesktopScope = z.looseObject({
  id: z.string(),
  path: z.string(),
  mode: storedEnum(['read', 'read-write']),
  kind: storedEnum(['folder', 'file']),
  grantedAt: z.number(),
  session: z.boolean().optional(),
});

export const DesktopConfirmRequest = z.looseObject({
  id: z.string(),
  tool: z.string(),
  danger: DesktopDanger,
  summary: z.string(),
  argsJson: z.string(),
  preview: z.string().optional(),
  dialog: z.boolean(),
  rememberable: z.boolean(),
  reason: z.string(),
  expiresAt: z.number(),
  /** scope：请用户授权文件夹（只发给对话窗口）；scopePath 为模型建议的文件夹 */
  kind: z.literal('scope').optional(),
  scopePath: z.string().optional(),
  scopeMode: z.enum(['read', 'read-write']).optional(),
});

export const DesktopState = z.looseObject({
  scopes: z.array(DesktopScope),
  policies: z.record(z.string(), DesktopPolicy),
  localOnly: z.boolean(),
  cloudAcked: z.array(z.string()),
  tools: z.array(
    z.looseObject({
      name: z.string(),
      danger: DesktopDanger,
      policy: DesktopPolicy,
      locked: z.boolean().optional(),
    }),
  ),
  pending: z.array(DesktopConfirmRequest).optional(),
});

export const DesktopAuditEntry = z.looseObject({
  ts: z.number(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  decision: z.string(),
  result: z.string(),
  ms: z.number().optional(),
  source: z.string().optional(),
  provider: z.string().optional(),
});

export const DesktopJournalEntry = z.looseObject({
  id: z.string(),
  ts: z.number(),
  tool: z.string(),
  summary: z.string(),
  undone: z.boolean(),
});

export const DesktopUndoResult = z.object({
  ok: z.boolean(),
  undone: z.string().optional(),
  error: z.string().optional(),
});

export const RepeatRule = z.union([
  z.object({ kind: z.literal('daily') }),
  z.object({ kind: z.literal('weekdays') }),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number()) }),
  z.object({ kind: z.literal('monthly') }),
  z.object({ kind: z.literal('interval'), minutes: z.number() }),
]);

export const Reminder = z.looseObject({
  id: z.string(),
  text: z.string(),
  dueAt: z.number(),
  createdAt: z.number(),
  status: storedEnum(['pending', 'fired', 'missed', 'cancelled', 'done']),
  firedAt: z.number().optional(),
  snoozes: z.number().optional(),
  announced: z.boolean().optional(),
  repeat: z.looseObject({ kind: z.string() }).optional(),
  anchorAt: z.number().optional(),
  fireCount: z.number().optional(),
});

export const ReminderCreateInput = z.object({
  text: z.string(),
  at: z.string().optional(),
  inMinutes: z.number().optional(),
  repeat: RepeatRule.optional(),
});

export const ReminderUpdatePatch = z.object({
  text: z.string().optional(),
  at: z.string().optional(),
  /** null = 取消重复 */
  repeat: RepeatRule.nullable().optional(),
});

export const DesktopReminderEvent = z.looseObject({
  id: z.string(),
  text: z.string(),
  dueAt: z.number(),
  missed: z.boolean().optional(),
});

export const DesktopBubble = z.looseObject({
  text: z.string(),
  voice: storedEnum(['full', 'cue', 'none']).optional(),
  kind: storedEnum(['digest', 'done', 'fail']).optional(),
});

export const DesktopSummaryEvent = z.looseObject({
  name: z.string(),
  path: z.string(),
  summary: z.string(),
  at: z.number(),
});

/** 发送前检查（云端告知 / 仅本地模式）的结论 */
export const SendCheck = z.enum(['ok', 'local_only', 'user_denied']);

/** 导航事件：对话窗口切到某个面板（payload 目前是空对象） */
export const NavRequest = z.looseObject({});

/** 对话窗口的面板导航事件名（`nav.takePending` 返回其中之一） */
export const ChatNavEvent = z.enum([
  'providers.openPanel',
  'nav.desktopPanelRequested',
  'nav.scheduleRequested',
  'nav.voiceSettingsRequested',
]);
