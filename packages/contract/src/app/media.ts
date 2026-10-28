/**
 * D1 · 语音 / 朗读 / 桌面能力 / 屏幕（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D1：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：voice、tts、desktop、screen、nav（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:voice:*`（voice/VoiceService.ts；视图 packages/voice/src/bridge.ts）
 * - 朗读：`getTTSConfig` / `saveTTSConfig` / `testTTSConnection` / `resetTTSConfig` / `tts:*`
 *   （handlers/ipc/ConfigIpcHandler.ts；electronAPI.tts / ttsSpeak / ttsStop / ttsHealth / ttsPromptVoice）
 * - 旧语音设置：`get-voice-settings` / `save-voice-settings` / `voice-settings:changed`
 *   （handlers/ipc/VoiceIpcHandler.ts；electronAPI.getVoiceSettings / saveVoiceSettings / onVoiceSettingsChanged）
 * - `ai:desktop:*`、`desktop:*`（desktop/DesktopService.ts；electronAPI.desktop）
 * - `ai:screen:check-send`（screen/ScreenService.ts）
 * - 导航事件 `ai:desktop:open-panel` / `ai:hub:open-schedule` / `ai:settings:open-voice`
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。
 */

import type { EventMap, ProcedureMap } from '../contract';

export const mediaProcedures = {} as const satisfies ProcedureMap;

export const mediaEvents = {} as const satisfies EventMap;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const mediaErrors = [] as const satisfies readonly string[];

export type MediaProcedureName = keyof typeof mediaProcedures & string;
export type MediaEventName = keyof typeof mediaEvents & string;
