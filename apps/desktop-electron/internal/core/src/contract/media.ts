/**
 * D1 的处理函数（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D1。契约声明在 packages/contract/src/app/media.ts；这里：
 * - `createMediaHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）。服务直接发布契约事件
 *   （`events.publish('voice.changed', …)`），这里不做转换。
 *
 * 按窗口的会话（VAD、流式识别）与只接受看板娘窗口的操作（确认答复、提醒卡片、拖文件）用
 * `callerWebContentsId(ctx)` 代替旧的 `event.sender`，窗口存活由宿主经 `services.callerWindows` 报告，
 * 见 ./media/voiceSenders.ts。打开语音设置走声明式窗口意图（`ports.windows.open('chat', { route: 'voice' })`）。
 */

import { PushStream } from '@nomi-ai/contract';
import type { MediaProcedureName } from '@nomi-ai/contract/app';
import type { TTSConfig, TTSPreviewRequest, VoiceSettings } from '@nomi-ai/types';

import { isChatNavEvent } from '../core/chatNav';
import { getMascotVoiceSettings, saveMascotVoiceSettings } from '../voice/mascotVoiceSettings';

import { createVoiceStreams, type VoiceStreamChunk, type VoiceStreams } from './media/voiceSenders';
import {
  callerWebContentsId,
  need,
  type AppHandlerContext,
  type ContractDeps,
  type DomainHandlers,
} from './types';

export type MediaHandlers = DomainHandlers<MediaProcedureName>;

/**
 * 服务的返回类型多是 interface（没有索引签名），契约输出是 `z.looseObject`（带 `[k: string]: unknown`），
 * TS 不认两者兼容；形状由契约在运行时校验（BAD_OUTPUT），这里只在类型上放行。
 */
const out = <T>(v: unknown): T => v as T;

/** `streams`：进行中的流式识别会话（每个 router 一份；测试可传入以观察） */
export function createMediaHandlers(
  deps: ContractDeps,
  streams: VoiceStreams = createVoiceStreams(),
): MediaHandlers {
  const { services } = deps;
  const voice = () => need(services.voice, 'voice');
  const desktop = () => need(services.desktop, 'desktop');
  const tts = () => need(services.tts, 'tts');
  const config = () => need(services.config, 'config');
  const sender = (ctx: Pick<AppHandlerContext, 'caller'>) =>
    streams.senderFor(services.callerWindows, callerWebContentsId(ctx));

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
      streams.open(sid, wc.id, stream);
      stream.push({ type: 'start', ok: true, id: sid });
      // 调用被取消（abort 帧、窗口断开）时流可能还在等下一条 chunk：直接撤销并结束它
      ctx.signal.addEventListener(
        'abort',
        () => {
          svc.streamCancel(wc, sid);
          streams.close(sid, wc.id);
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
        streams.close(id, wc.id);
      }
    },
    'voice.streamCancel': ({ id }, ctx) => {
      const wc = sender(ctx);
      const ok = voice().streamCancel(wc, id);
      streams.close(id, wc.id);
      return ok;
    },
    'voice.getMascotSettings': () => out(getMascotVoiceSettings(config()) ?? null),
    'voice.saveMascotSettings': (settings) =>
      saveMascotVoiceSettings(
        config(),
        settings as Partial<VoiceSettings>,
        deps.logger,
        deps.events,
      ),

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
    'desktop.confirmAnswer': ({ id, allow, remember, pick }, ctx) =>
      desktop().answerConfirm(
        callerWebContentsId(ctx),
        id,
        allow,
        remember,
        pick,
        ctx.caller.surface,
      ),
    'desktop.reminderAction': ({ id, action, minutes }, ctx) =>
      desktop().reminderAction(callerWebContentsId(ctx), id, action, minutes),
    'desktop.takeMissedReminders': (_input, ctx) =>
      desktop().takeMissedFor(callerWebContentsId(ctx)),
    'desktop.takePendingSummary': () =>
      out(need(services.pendingEvents, 'pendingEvents').take('summary')?.payload ?? null),

    // ── 屏幕 / 导航 ──
    'screen.checkSend': () => need(services.screen, 'screen').checkSend(),
    'nav.openVoiceSettings': () => deps.ports.windows.open('chat', { route: 'voice' }),
    'nav.takePending': () => {
      const p = need(services.pendingEvents, 'pendingEvents').take('nav');
      return p && isChatNavEvent(p.event) ? { event: p.event } : null;
    },
  };
}
