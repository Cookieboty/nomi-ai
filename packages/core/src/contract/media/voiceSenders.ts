/**
 * D1：语音服务按「发起的窗口」管理的会话（VAD、豆包流式识别）在契约上的适配。
 *
 * VoiceService 按发起方（原来是 IPC 的 `event.sender`）管理会话：会话归属看 `sender.id`，窗口销毁时
 * （`once('destroyed')`）释放，流式识别的临时结果用 `sender.send('ai:voice:stream', …)` 只回给它。
 * 契约里调用方只有 `caller.id`（Electron：webContents id）；窗口的存活由宿主经 `CallerWindows` 报告
 * （内核不认识窗口），`ai:voice:stream` 的推送改投到对应会话的 `voice.streamStart` 流里（按会话 id 分发；
 * 推音频时的错误也回到发起的那条流）。
 *
 * 进行中的流登记在 `createVoiceStreams()` 的实例里（每个 router 一份，不是模块级状态）。
 */

import type { HandlerChunkOf, PushStream } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';

import type { VoiceSender } from '../../voice/VoiceService';

export type VoiceStreamChunk = HandlerChunkOf<AppContract['procedures']['voice.streamStart']>;
type StreamChunk = VoiceStreamChunk;

/** 调用方窗口的最小形状（Electron 的 webContents 结构上满足） */
export interface CallerWindowLike {
  id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

/** 宿主提供：按调用方 id 找回它的窗口；没有窗口概念的宿主（无界面）不提供 */
export interface CallerWindows {
  find(callerId: number): CallerWindowLike | null;
}

export interface VoiceStreams {
  /**
   * 调用方 → VoiceSender。找不到窗口（测试调用方、辅助窗口、无界面宿主）时会话照常归属这个 id，
   * 只是不会随窗口销毁自动释放（契约会话断开时进行中的流仍会取消）。
   */
  senderFor(windows: CallerWindows | undefined, callerId: number | undefined): VoiceSender;
  /** 登记一条流式识别会话的流（owner：发起窗口的 id，与 VoiceService 的会话归属一致） */
  open(id: string, owner: number, stream: PushStream<StreamChunk>): void;
  /** 会话结束（stop / cancel 之后）：结束对应的流；别的窗口结束不了 */
  close(id: string, owner: number): void;
  /** 测试用：进行中的流数量 */
  count(): number;
}

export function createVoiceStreams(): VoiceStreams {
  /** 进行中的流式识别会话 id → 它的 `voice.streamStart` 流 */
  const streams = new Map<string, { owner: number; stream: PushStream<StreamChunk> }>();
  return {
    senderFor(windows, callerId) {
      const wc = callerId === undefined ? null : (windows?.find(callerId) ?? null);
      return {
        id: callerId ?? 0,
        isDestroyed: () => wc?.isDestroyed() ?? false,
        once: (event, listener) => wc?.once(event, listener),
        send: (channel, payload) => {
          if (channel !== 'ai:voice:stream') return;
          const p = payload as StreamChunk & { id?: unknown };
          if (typeof p?.id === 'string') streams.get(p.id)?.stream.push(p);
        },
      };
    },
    open(id, owner, stream) {
      streams.get(id)?.stream.end(undefined);
      streams.set(id, { owner, stream });
    },
    close(id, owner) {
      const s = streams.get(id);
      if (!s || s.owner !== owner) return;
      streams.delete(id);
      s.stream.end(undefined);
    },
    count: () => streams.size,
  };
}
