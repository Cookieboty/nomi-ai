/**
 * D1 的处理函数与事件桥（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D1。契约声明在 packages/contract/src/app/media.ts；这里：
 * - `createMediaHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE；朗读服务用 `getTtsService()`）；
 * - `mediaEventBridge`：服务仍在 `events.publish` 的旧通道 → 契约事件。
 *
 * 按窗口的会话（VAD、流式识别）与只接受看板娘窗口的操作（确认答复、提醒卡片、拖文件）用
 * `callerWebContentsId(ctx)` 代替旧的 `event.sender`，见 ./media/voiceSenders.ts。
 */

import { PushStream } from '@nomi-ai/contract';
import type { MediaEventName, MediaProcedureName } from '@nomi-ai/contract/app';
import type { TTSConfig, TTSPreviewRequest, VoiceSettings } from '@nomi-ai/types';

import { getTtsService } from '../../tts/TtsService';
import { getMascotVoiceSettings, saveMascotVoiceSettings } from '../../voice/mascotVoiceSettings';

import {
  closeVoiceStream,
  openVoiceStream,
  voiceSenderFor,
  type VoiceStreamChunk,
} from './media/voiceSenders';
import {
  callerWebContentsId,
  need,
  type AppHandlerContext,
  type ContractDeps,
  type DomainHandlers,
  type EventBridgeMap,
} from './types';

export type MediaHandlers = DomainHandlers<MediaProcedureName>;

/**
 * 服务的返回类型多是 interface（没有索引签名），契约输出是 `z.looseObject`（带 `[k: string]: unknown`），
 * TS 不认两者兼容；形状由契约在运行时校验（BAD_OUTPUT），这里只在类型上放行。
 */
const out = <T>(v: unknown): T => v as T;

/** 「设置 → 语音与屏幕 → 语音」面板的旧通道（WindowManager.openProviderPanel 发给对话窗口） */
const OPEN_VOICE_SETTINGS = 'ai:settings:open-voice';

export function createMediaHandlers(deps: ContractDeps): MediaHandlers {
  const { services } = deps;
  const voice = () => need(services.voice, 'voice');
  const desktop = () => need(services.desktop, 'desktop');
  const tts = () => need(getTtsService(), 'tts');
  const config = () => need(services.config, 'config');
  const sender = (ctx: Pick<AppHandlerContext, 'caller'>) =>
    voiceSenderFor(services, callerWebContentsId(ctx));

  return {
    // ── 语音输入 ──
    'voice.state': () => out(voice().state()),
    'voice.setSettings': (patch) => out(voice().setSettings(patch)),
    'voice.ackCloud': () => out(voice().ackCloud()),
    'voice.download': ({ id }) => voice().download(id),
    'voice.cancel': ({ id }) => voice().cancel(id),
    'voice.remove': ({ id }) => voice().remove(id),
    'voice.vadOpen': (_input, ctx) => voice().vadOpen(sender(ctx)),
    'voice.vadProb': ({ handle, frame }, ctx) => voice().vadProb(sender(ctx).id, handle, frame),
    'voice.vadClose': ({ handle }, ctx) => voice().vadClose(sender(ctx).id, handle),
    'voice.transcribe': ({ wav, source, purpose }) =>
      voice().transcribeResult(wav, { source: source ?? 'chat', purpose }),
    'voice.activity': ({ activity, source }) => voice().reportActivity(activity, source),
    'voice.sendToChat': ({ text }) => voice().sendToChat(text.slice(0, 4000)),
    'voice.volcSetKey': ({ key }) => voice().setVolcKey(key),
    'voice.volcClearKey': () => voice().clearVolcKey(),
    'voice.volcTest': () => voice().volcTest(),
    'voice.streamStart': ({ source }, ctx) => {
      const svc = voice();
      const wc = sender(ctx);
      let id: string | null = null;
      // 视图放弃这条流 / 窗口断开：撤销会话（之后不再外发音频、不交付结果）
      const stream = new PushStream<VoiceStreamChunk>(() => {
        if (id) svc.streamCancel(wc, id);
      });
      const r = svc.streamStart(wc, source);
      if (!r.ok) {
        stream.push({ type: 'start', ok: false, code: r.code, error: r.error });
        stream.end(undefined);
        return stream;
      }
      const sid = r.id;
      id = sid;
      openVoiceStream(sid, wc.id, stream);
      stream.push({ type: 'start', ok: true, id: sid });
      // 调用被取消（abort 帧、窗口断开）时流可能还在等下一条 chunk：直接撤销并结束它
      ctx.signal.addEventListener(
        'abort',
        () => {
          svc.streamCancel(wc, sid);
          closeVoiceStream(sid, wc.id);
        },
        { once: true },
      );
      return stream;
    },
    'voice.streamPush': ({ id, pcm }, ctx) => voice().streamPush(sender(ctx), id, pcm),
    'voice.streamStop': async ({ id }, ctx) => {
      const wc = sender(ctx);
      try {
        return await voice().streamStop(wc, id);
      } finally {
        closeVoiceStream(id, wc.id);
      }
    },
    'voice.streamCancel': ({ id }, ctx) => {
      const wc = sender(ctx);
      const ok = voice().streamCancel(wc, id);
      closeVoiceStream(id, wc.id);
      return ok;
    },
    'voice.getMascotSettings': () => out(getMascotVoiceSettings(config()) ?? null),
    'voice.saveMascotSettings': (settings) =>
      saveMascotVoiceSettings(config(), settings as Partial<VoiceSettings>, deps.logger),

    // ── 朗读 ──
    'tts.getConfig': () => out(tts().getConfig()),
    'tts.saveConfig': (cfg) => {
      tts().saveConfig(cfg as TTSConfig);
    },
    'tts.testConnection': async (cfg) => out(await tts().testConnection(cfg as TTSConfig)),
    'tts.resetConfig': () => tts().resetConfig(),
    'tts.voices': async () => out(await tts().voices()),
    'tts.preview': async (req) => out(await tts().preview(req as TTSPreviewRequest)),
    'tts.status': () => out(tts().status()),
    'tts.stop': () => tts().stop(),
    'tts.reply': (msg) => tts().reply(msg),
    'tts.speak': async (req) => out(await tts().speak(req)),
    'tts.health': (cfg) => out(tts().health(cfg as Partial<TTSConfig> | undefined)),
    'tts.promptVoice': () => tts().promptVoice(),

    // ── 桌面能力 ──
    'desktop.state': () => out(desktop().state()),
    'desktop.grant': async ({ mode }) => out(await desktop().grantFolder(mode)),
    'desktop.revoke': ({ id }) => desktop().revokeScope(id),
    'desktop.setPolicy': ({ tool, policy }) => desktop().setToolPolicy(tool, policy),
    'desktop.setLocalOnly': ({ value }) => desktop().setLocalOnly(value),
    'desktop.audit': ({ limit }) => out(desktop().auditList(limit)),
    'desktop.auditClear': () => desktop().clearAudit(),
    'desktop.journal': () => out(desktop().journalList()),
    'desktop.undoLast': () => desktop().undoLast(),
    'desktop.resetAll': () => desktop().resetAll(),
    'desktop.resetCloudAcks': () => desktop().resetCloudAcks(),
    'desktop.remindersList': ({ all }) => out(desktop().remindersList(all)),
    'desktop.remindersCreate': (input) => out(desktop().createReminder(input)),
    'desktop.remindersUpdate': ({ id, patch }) => out(desktop().updateReminder(id, patch)),
    'desktop.remindersCancel': ({ id }) => desktop().cancelReminder(id),
    'desktop.remindersSnooze': ({ id, minutes }) => desktop().snoozeReminder(id, minutes),
    'desktop.confirmAnswer': ({ id, allow, remember }, ctx) =>
      desktop().answerConfirm(callerWebContentsId(ctx), id, allow, remember),
    'desktop.reminderAction': ({ id, action, minutes }, ctx) =>
      desktop().reminderAction(callerWebContentsId(ctx), id, action, minutes),
    'desktop.takeMissedReminders': (_input, ctx) =>
      desktop().takeMissedFor(callerWebContentsId(ctx)),

    // ── 屏幕 / 导航 ──
    'screen.checkSend': () => need(services.screen, 'screen').checkSend(),
    'nav.openVoiceSettings': () =>
      need(services.windowManager, 'windowManager').openProviderPanel(OPEN_VOICE_SETTINGS),
  };
}

export const mediaEventBridge: EventBridgeMap<MediaEventName> = {
  'ai:voice:changed': 'voice.changed',
  'ai:voice:progress': 'voice.progress',
  'ai:voice:activity': 'voice.activity',
  'ai:voice:bargeIn': 'voice.bargeIn',
  'ai:voice:inject': 'voice.inject',
  'voice-settings:changed': 'voice.mascotSettingsChanged',
  'ai:desktop:changed': 'desktop.changed',
  'ai:desktop:p2-changed': 'desktop.p2Changed',
  'ai:desktop:summary': 'desktop.summary',
  'desktop:confirm-request': 'desktop.confirmRequest',
  'desktop:confirm-cancel': 'desktop.confirmCancel',
  'desktop:bubble': 'desktop.bubble',
  'desktop:reminder': 'desktop.reminder',
  // 导航：WindowManager.openProviderPanel 目前直接 webContents.send，改走事件总线后这里生效
  'ai:desktop:open-panel': 'nav.desktopPanelRequested',
  'ai:hub:open-schedule': 'nav.scheduleRequested',
  [OPEN_VOICE_SETTINGS]: 'nav.voiceSettingsRequested',
};
