/**
 * D1 的处理函数（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 本文件只属于 D1。契约声明在 packages/contract/src/app/media.ts；这里：
 * - `createMediaHandlers(deps)`：每个过程一个处理函数，委派给服务的公开方法（服务从
 *   `deps.services` 在调用时读取，缺了用 `need()` 报 UNAVAILABLE）。服务直接发布契约事件
 *   （`events.publish('voice.changed', …)`），这里不做转换。
 *
 * 按发起方的会话（VAD、流式识别）归属调用方 id（`callerWebContentsId(ctx)`），发起方窗口关闭时由内核经
 * `ports.windows.onCallerClosed` 释放；流式识别的临时结果写进发起方这条 `voice.streamStart` 流
 * （VoiceService 的 VoiceStreamSink）。只接受看板娘窗口的操作（确认答复、提醒卡片）把 `caller.id` 交给
 * DesktopService，由 `ports.windows.ownsCaller('mascot', …)` 核对。打开窗口一律走声明式窗口意图。
 */

import { PushStream, type HandlerChunkOf } from '@nomi-ai/contract';
import type { AppContract, MediaProcedureName } from '@nomi-ai/contract/app';
import type { TTSConfig, TTSPreviewRequest, VoiceSettings } from '@nomi-ai/types';

import { isChatNavEvent } from '../core/chatNav';
import { getMascotVoiceSettings, saveMascotVoiceSettings } from '../voice/mascotVoiceSettings';

import {
  callerWebContentsId,
  need,
  type AppHandlerContext,
  type ContractDeps,
  type DomainHandlers,
} from './types';

export type MediaHandlers = DomainHandlers<MediaProcedureName>;

type VoiceStreamChunk = HandlerChunkOf<AppContract['procedures']['voice.streamStart']>;

/**
 * 服务的返回类型多是 interface（没有索引签名），契约输出是 `z.looseObject`（带 `[k: string]: unknown`），
 * TS 不认两者兼容；形状由契约在运行时校验（BAD_OUTPUT），这里只在类型上放行。
 */
const out = <T>(v: unknown): T => v as T;

export function createMediaHandlers(deps: ContractDeps): MediaHandlers {
  const { services } = deps;
  const voice = () => need(services.voice, 'voice');
  const desktop = () => need(services.desktop, 'desktop');
  const tts = () => need(services.tts, 'tts');
  const config = () => need(services.config, 'config');
  /** 会话归属：调用方 id（窗口的 webContents id；找不到时 0，见 callerWebContentsId） */
  const ownerOf = (ctx: Pick<AppHandlerContext, 'caller'>) => callerWebContentsId(ctx) ?? 0;

  return {
    // ── 语音输入 ──
    'voice.state': () => out(voice().state()),
    'voice.setSettings': (patch) => out(voice().setSettings(patch)),
    'voice.ackCloud': () => out(voice().ackCloud()),
    'voice.download': ({ id }) => voice().download(id),
    'voice.cancel': ({ id }) => voice().cancel(id),
    'voice.remove': ({ id }) => voice().remove(id),
    'voice.vadOpen': (_input, ctx) => voice().vadOpen(ownerOf(ctx)),
    'voice.vadProb': ({ handle, frame }, ctx) => voice().vadProb(ownerOf(ctx), handle, frame),
    'voice.vadClose': ({ handle }, ctx) => voice().vadClose(ownerOf(ctx), handle),
    'voice.transcribe': ({ wav, source, purpose }) =>
      voice().transcribeResult(wav, { source: source ?? 'chat', purpose }),
    'voice.activity': ({ activity, source }) => voice().reportActivity(activity, source),
    'voice.sendToChat': ({ text }) => voice().sendToChat(text.slice(0, 4000)),
    'voice.volcSetKey': ({ key }) => voice().setVolcKey(key),
    'voice.volcClearKey': () => voice().clearVolcKey(),
    'voice.volcTest': () => voice().volcTest(),
    'voice.streamStart': ({ source }, ctx) => {
      const svc = voice();
      const owner = ownerOf(ctx);
      let id: string | null = null;
      // 视图放弃这条流 / 窗口断开：撤销会话（之后不再外发音频、不交付结果）
      const stream = new PushStream<VoiceStreamChunk>(() => {
        if (id) svc.streamCancel(owner, id);
      });
      // 会话的出口就是这条流：临时结果 / 错误写进来，会话结束（stop、取消、撤销、窗口关闭）时服务结束它
      const r = svc.streamStart(owner, source, {
        push: (e) => stream.push(e),
        end: () => stream.end(undefined),
      });
      if (!r.ok) {
        stream.push({ type: 'start', ok: false, code: r.code, error: r.error });
        stream.end(undefined);
        return stream;
      }
      const sid = r.id;
      id = sid;
      stream.push({ type: 'start', ok: true, id: sid });
      // 调用被取消（abort 帧、窗口断开）时流可能还在等下一条 chunk：直接撤销（服务随之结束这条流）
      ctx.signal.addEventListener('abort', () => svc.streamCancel(owner, sid), { once: true });
      return stream;
    },
    'voice.streamPush': ({ id, pcm }, ctx) => voice().streamPush(ownerOf(ctx), id, pcm),
    'voice.streamStop': ({ id }, ctx) => voice().streamStop(ownerOf(ctx), id),
    'voice.streamCancel': ({ id }, ctx) => voice().streamCancel(ownerOf(ctx), id),
    'voice.takePendingInject': () =>
      out(need(services.pendingEvents, 'pendingEvents').take('voiceInject')?.payload ?? null),
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
    'desktop.confirmAnswer': ({ id, allow, remember }, ctx) =>
      desktop().answerConfirm(ctx.caller.id, id, allow, remember),
    'desktop.reminderAction': ({ id, action, minutes }, ctx) =>
      desktop().reminderAction(ctx.caller.id, id, action, minutes),
    'desktop.takeMissedReminders': (_input, ctx) => desktop().takeMissedFor(ctx.caller.id),
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
