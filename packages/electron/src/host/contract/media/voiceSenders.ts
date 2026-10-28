/**
 * D1：语音服务按「发起的窗口」管理的会话（VAD、豆包流式识别）在契约上的适配。
 *
 * VoiceService 按 Electron 的 sender 管理会话（原来直接拿 IPC 的 `event.sender`）：会话归属看 `sender.id`，窗口销毁时
 * （`once('destroyed')`）释放，流式识别的临时结果用 `sender.send('ai:voice:stream', …)` 只回给它。
 * 契约里调用方只有 `caller.id`（webContents id），这里据此找回窗口，并把 `ai:voice:stream` 的推送
 * 改投到对应会话的 `voice.streamStart` 流里（按会话 id 分发；推音频时的错误也回到发起的那条流）。
 */

import type { HandlerChunkOf, PushStream } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';

import type { VoiceSender } from '../../../voice/VoiceService';
import type { ContractServices } from '../services';

export type VoiceStreamChunk = HandlerChunkOf<AppContract['procedures']['voice.streamStart']>;
type StreamChunk = VoiceStreamChunk;

/** 窗口能力的最小形状（BrowserWindow.webContents 结构上满足） */
interface WebContentsLike {
  id: number;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

/** 进行中的流式识别会话 id → 它的 `voice.streamStart` 流 */
const streams = new Map<string, { owner: number; stream: PushStream<StreamChunk> }>();

function findWebContents(
  services: Pick<ContractServices, 'windowManager'>,
  id: number | undefined,
): WebContentsLike | null {
  if (id === undefined) return null;
  const wm = services.windowManager;
  for (const w of [wm?.getMainWindow(), wm?.getAiChatWindow()]) {
    if (w && !w.isDestroyed() && w.webContents.id === id) return w.webContents;
  }
  return null;
}

/**
 * 调用方窗口 → VoiceSender。找不到窗口（测试调用方、辅助窗口）时会话照常归属这个 id，
 * 只是不会随窗口销毁自动释放（契约会话断开时进行中的流仍会取消）。
 */
export function voiceSenderFor(
  services: Pick<ContractServices, 'windowManager'>,
  callerId: number | undefined,
): VoiceSender {
  const wc = findWebContents(services, callerId);
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
}

/** 登记一条流式识别会话的流（owner：发起窗口的 id，与 VoiceService 的会话归属一致） */
export function openVoiceStream(id: string, owner: number, stream: PushStream<StreamChunk>): void {
  streams.get(id)?.stream.end(undefined);
  streams.set(id, { owner, stream });
}

/** 会话结束（stop / cancel 之后）：结束对应的流；别的窗口结束不了 */
export function closeVoiceStream(id: string, owner: number): void {
  const s = streams.get(id);
  if (!s || s.owner !== owner) return;
  streams.delete(id);
  s.stream.end(undefined);
}

/** 测试用：进行中的流数量 */
export function openVoiceStreamCount(): number {
  return streams.size;
}
