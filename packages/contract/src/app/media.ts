/**
 * D1 · 语音 / 朗读 / 桌面能力 / 屏幕（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D1：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：voice、tts、desktop、screen、nav（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:voice:*`（voice/VoiceService.ts；视图 packages/voice/src/bridge.ts）
 * - 朗读：`getTTSConfig` / `saveTTSConfig` / `testTTSConnection` / `resetTTSConfig` / `tts:*`
 *   （tts/TtsService.ts，旧注册在 handlers/ipc/ConfigIpcHandler.ts；electronAPI.tts / ttsSpeak / ttsStop /
 *   ttsHealth / ttsPromptVoice）
 * - 旧语音设置：`get-voice-settings` / `save-voice-settings` / `voice-settings:changed`
 *   （handlers/ipc/VoiceIpcHandler.ts；electronAPI.getVoiceSettings / saveVoiceSettings / onVoiceSettingsChanged）
 * - `ai:desktop:*`、`desktop:*`（desktop/DesktopService.ts；electronAPI.desktop）
 * - `ai:screen:check-send`（screen/ScreenService.ts）
 * - 导航：`open-voice-settings`，事件 `ai:desktop:open-panel` / `ai:hub:open-schedule` / `ai:settings:open-voice`
 *
 * 安全（§8）：
 * - `ai:*` 两个窗口都有，不写 surfaces；只在一个 preload 里暴露的写 surfaces：看板娘（preload.ts 的
 *   electronAPI）`['mascot']`，对话窗口（ai-chat-preload.ts 的 electronAPI.tts）`['chat']`；`tts:stop` 两边都有；
 * - 回答用户确认、授予权限的写 `dangerous: true`：确认答复、授权文件夹、工具策略、仅本地开关、全部重置、
 *   语音云端告知确认。
 *
 * 流式识别（豆包 2.0）：旧的 `ai:voice:stream` 只推给发起的窗口，这里改成 stream 过程 `voice.streamStart`
 * （第一条 chunk 是启动结果，之后是这个会话的临时结果 / 错误）；推音频、结束、取消仍按会话 id 调用，
 * 结束或取消之后流随之结束。
 */

import { z } from 'zod';

import type { EventMap, ProcedureMap } from '../contract';

import {
  DesktopAuditEntry,
  DesktopBubble,
  DesktopConfirmRequest,
  DesktopJournalEntry,
  DesktopReminderEvent,
  DesktopScope,
  DesktopState,
  DesktopSummaryEvent,
  DesktopUndoResult,
  MascotVoiceSettings,
  NavRequest,
  Reminder,
  ReminderCreateInput,
  ReminderUpdatePatch,
  SendCheck,
  TtsConfig,
  TtsConfigInput,
  TtsPreviewInput,
  TtsReplyInput,
  TtsSpeakInput,
  TtsSpeakResult,
  TtsStatus,
  TtsTestResult,
  TtsVoiceList,
  VoiceActivityEvent,
  VoiceInjectEvent,
  VoiceOkResult,
  VoiceProgressEvent,
  VoiceSettings,
  VoiceSettingsPatch,
  VoiceState,
  VoiceStreamChunk,
  VoiceTranscribeInput,
  VoiceTranscribeResult,
  VoiceVadOpenResult,
} from './media/schemas';
import { Bytes } from './schemas';

const byId = z.object({ id: z.string() });

export const mediaProcedures = {
  // ── 语音输入（ai:voice:*，两个窗口都有）───────────────────────────────
  'voice.state': { kind: 'query', input: z.void(), output: VoiceState },
  'voice.setSettings': { kind: 'mutation', input: VoiceSettingsPatch, output: VoiceSettings },
  /** 「录音将发送到云端」告知的确认 */
  'voice.ackCloud': { kind: 'mutation', input: z.void(), output: VoiceSettings, dangerous: true },
  'voice.download': { kind: 'mutation', input: byId, output: VoiceOkResult },
  'voice.cancel': { kind: 'mutation', input: byId, output: z.boolean() },
  'voice.remove': { kind: 'mutation', input: byId, output: z.boolean() },
  /** 每个窗口独立的 Silero 会话；没有模型时退回能量检测 */
  'voice.vadOpen': { kind: 'mutation', input: z.void(), output: VoiceVadOpenResult },
  /** frame：32ms Float32 PCM 帧的字节（`new Uint8Array(f.buffer, f.byteOffset, f.byteLength)`） */
  'voice.vadProb': {
    kind: 'mutation',
    input: z.object({ handle: z.string(), frame: Bytes }),
    output: z.number(),
  },
  'voice.vadClose': {
    kind: 'mutation',
    input: z.object({ handle: z.string() }),
    output: z.void(),
  },
  'voice.transcribe': {
    kind: 'mutation',
    input: VoiceTranscribeInput,
    output: VoiceTranscribeResult,
  },
  /** 上报语音活动（看板娘表情、打断朗读）；activity 不认识时返回 false */
  'voice.activity': {
    kind: 'mutation',
    input: z.object({ activity: z.string(), source: z.string() }),
    output: z.boolean(),
  },
  /** 看板娘识别到的话 → 对话窗口（事件 voice.inject） */
  'voice.sendToChat': {
    kind: 'mutation',
    input: z.object({ text: z.string() }),
    output: z.void(),
  },
  'voice.volcSetKey': {
    kind: 'mutation',
    input: z.object({ key: z.string() }),
    output: VoiceOkResult,
  },
  'voice.volcClearKey': { kind: 'mutation', input: z.void(), output: z.boolean() },
  'voice.volcTest': {
    kind: 'mutation',
    input: z.void(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  'voice.streamStart': {
    kind: 'stream',
    input: z.object({ source: z.string() }),
    chunk: VoiceStreamChunk,
  },
  'voice.streamPush': {
    kind: 'mutation',
    input: z.object({ id: z.string(), pcm: Bytes }),
    output: z.boolean(),
  },
  'voice.streamStop': { kind: 'mutation', input: byId, output: VoiceTranscribeResult },
  'voice.streamCancel': { kind: 'mutation', input: byId, output: z.boolean() },
  /** 看板娘的旧语音设置（音量、整点报时、音效）：electronAPI.getVoiceSettings */
  'voice.getMascotSettings': {
    kind: 'query',
    input: z.void(),
    output: MascotVoiceSettings.nullable(),
    surfaces: ['mascot'],
  },
  /** 合并保存（不广播）：electronAPI.saveVoiceSettings */
  'voice.saveMascotSettings': {
    kind: 'mutation',
    input: MascotVoiceSettings,
    output: z.void(),
    surfaces: ['mascot'],
  },

  // ── 朗读（tts）─────────────────────────────────────────────────────────
  'tts.getConfig': {
    kind: 'query',
    input: z.void(),
    output: TtsConfig.nullable(),
    surfaces: ['chat'],
  },
  /** 主进程校验不通过时抛错（INTERNAL，message 是原因） */
  'tts.saveConfig': {
    kind: 'mutation',
    input: TtsConfigInput,
    output: z.void(),
    surfaces: ['chat'],
  },
  'tts.testConnection': {
    kind: 'mutation',
    input: TtsConfigInput,
    output: TtsTestResult,
    surfaces: ['chat'],
  },
  'tts.resetConfig': { kind: 'mutation', input: z.void(), output: z.void(), surfaces: ['chat'] },
  'tts.voices': { kind: 'query', input: z.void(), output: TtsVoiceList, surfaces: ['chat'] },
  'tts.preview': {
    kind: 'mutation',
    input: TtsPreviewInput,
    output: TtsSpeakResult,
    surfaces: ['chat'],
  },
  'tts.status': { kind: 'query', input: z.void(), output: TtsStatus, surfaces: ['chat'] },
  /** 打断：取消还在等音频的合成（两个窗口都有） */
  'tts.stop': { kind: 'mutation', input: z.void(), output: z.boolean() },
  /** 朗读 AI 回复：对话窗口 → 主进程按配置决定是否转给看板娘 */
  'tts.reply': { kind: 'mutation', input: TtsReplyInput, output: z.boolean(), surfaces: ['chat'] },
  'tts.speak': {
    kind: 'mutation',
    input: TtsSpeakInput,
    output: TtsSpeakResult,
    surfaces: ['mascot'],
  },
  /** 实时朗读引擎是否可用；可传入未保存的 provider */
  'tts.health': {
    kind: 'query',
    input: z.looseObject({ provider: z.string().optional() }).optional(),
    output: TtsTestResult,
    surfaces: ['mascot'],
  },
  /** 诺米提示语音开关（默认开） */
  'tts.promptVoice': { kind: 'query', input: z.void(), output: z.boolean(), surfaces: ['mascot'] },

  // ── 桌面能力（ai:desktop:*，两个窗口都有）──────────────────────────────
  'desktop.state': { kind: 'query', input: z.void(), output: DesktopState },
  /** 由主进程弹出系统选择框授权文件夹；用户取消返回 null */
  'desktop.grant': {
    kind: 'mutation',
    input: z.object({ mode: z.enum(['read', 'read-write']) }),
    output: DesktopScope.nullable(),
    dangerous: true,
  },
  'desktop.revoke': { kind: 'mutation', input: byId, output: z.boolean() },
  'desktop.setPolicy': {
    kind: 'mutation',
    input: z.object({ tool: z.string(), policy: z.string() }),
    output: z.boolean(),
    dangerous: true,
  },
  'desktop.setLocalOnly': {
    kind: 'mutation',
    input: z.object({ value: z.boolean() }),
    output: z.boolean(),
    dangerous: true,
  },
  'desktop.audit': {
    kind: 'query',
    input: z.object({ limit: z.number().optional() }),
    output: z.array(DesktopAuditEntry),
  },
  'desktop.auditClear': { kind: 'mutation', input: z.void(), output: z.boolean() },
  'desktop.journal': { kind: 'query', input: z.void(), output: z.array(DesktopJournalEntry) },
  'desktop.undoLast': { kind: 'mutation', input: z.void(), output: DesktopUndoResult },
  'desktop.resetAll': { kind: 'mutation', input: z.void(), output: z.boolean(), dangerous: true },
  'desktop.resetCloudAcks': { kind: 'mutation', input: z.void(), output: z.boolean() },
  'desktop.remindersList': {
    kind: 'query',
    input: z.object({ all: z.boolean().optional() }),
    output: z.array(Reminder),
  },
  /** 文字为空或时间无效 / 已过去时返回 null */
  'desktop.remindersCreate': {
    kind: 'mutation',
    input: ReminderCreateInput,
    output: Reminder.nullable(),
  },
  'desktop.remindersUpdate': {
    kind: 'mutation',
    input: z.object({ id: z.string(), patch: ReminderUpdatePatch }),
    output: Reminder.nullable(),
  },
  'desktop.remindersCancel': { kind: 'mutation', input: byId, output: z.boolean() },
  'desktop.remindersSnooze': {
    kind: 'mutation',
    input: z.object({ id: z.string(), minutes: z.number().optional() }),
    output: z.boolean(),
  },
  // 看板娘窗口专用（preload.ts 的 electronAPI.desktop）；主进程还会核对调用方就是看板娘窗口
  /** 确认气泡 / 对话框的答复（模型与对话窗口都无法伪造） */
  'desktop.confirmAnswer': {
    kind: 'mutation',
    input: z.object({ id: z.string(), allow: z.boolean(), remember: z.boolean() }),
    output: z.void(),
    surfaces: ['mascot'],
    dangerous: true,
  },
  /** 拖到看板娘身上的文件：临时只读授权并总结（结果经气泡与 desktop.summary 回来） */
  'desktop.dropFile': {
    kind: 'mutation',
    input: z.object({ path: z.string().min(1) }),
    output: z.void(),
    surfaces: ['mascot'],
  },
  'desktop.reminderAction': {
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      action: z.enum(['dismiss', 'snooze']),
      minutes: z.number().optional(),
    }),
    output: z.void(),
    surfaces: ['mascot'],
  },
  /** 拉取关闭期间错过的提醒（拉取即视为已播报） */
  'desktop.takeMissedReminders': {
    kind: 'mutation',
    input: z.void(),
    output: z.array(DesktopReminderEvent),
    surfaces: ['mascot'],
  },

  // ── 屏幕 / 图片 ────────────────────────────────────────────────────────
  /** 发送图片前：云端告知 / 仅本地模式 */
  'screen.checkSend': { kind: 'mutation', input: z.void(), output: SendCheck },

  // ── 导航 ──────────────────────────────────────────────────────────────
  /** 看板娘「TTS 语音配置」/ 语音错误「去设置」：打开对话窗口的「设置 → 语音与屏幕 → 语音」 */
  'nav.openVoiceSettings': {
    kind: 'mutation',
    input: z.void(),
    output: z.void(),
    surfaces: ['mascot'],
  },
} as const satisfies ProcedureMap;

export const mediaEvents = {
  /** 语音设置 / 模型 / Key 变了（payload 为 null，界面重新读 voice.state） */
  'voice.changed': z.null(),
  'voice.progress': VoiceProgressEvent,
  'voice.activity': VoiceActivityEvent,
  'voice.bargeIn': z.looseObject({ source: z.string() }),
  /** 看板娘说的话投递到对话窗口 */
  'voice.inject': VoiceInjectEvent,
  /** 主进程改了看板娘的旧语音设置（旧通道 voice-settings:changed） */
  'voice.mascotSettingsChanged': MascotVoiceSettings,
  'desktop.changed': DesktopState,
  'desktop.p2Changed': z.looseObject({ kind: z.string() }),
  /** 拖文件总结完成：对话窗口显示全文 */
  'desktop.summary': DesktopSummaryEvent,
  /** 看板娘窗口：工具调用确认请求 / 取消（id）/ 气泡 / 提醒到点 */
  'desktop.confirmRequest': DesktopConfirmRequest,
  'desktop.confirmCancel': z.string(),
  'desktop.bubble': DesktopBubble,
  'desktop.reminder': DesktopReminderEvent,
  /** 对话窗口切到某个面板（托盘 / 看板娘工具栏触发） */
  'nav.desktopPanelRequested': NavRequest,
  'nav.scheduleRequested': NavRequest,
  'nav.voiceSettingsRequested': NavRequest,
} as const satisfies EventMap;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const mediaErrors = [] as const satisfies readonly string[];

export type MediaProcedureName = keyof typeof mediaProcedures & string;
export type MediaEventName = keyof typeof mediaEvents & string;
