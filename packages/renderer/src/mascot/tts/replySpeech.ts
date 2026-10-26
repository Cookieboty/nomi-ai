/**
 * 朗读 AI 回复（看板娘窗口一侧）：对话窗口边生成边把整句经主进程（tts:reply → mascot:command）发过来，
 * 这里按到达顺序排队，经 tts:speak 合成（预取下一句）后用 playSynthesized 播放，口型同步与打断
 * 跟其它语音共用。新回复（id 变了）/ stop / 按住说话 / 别的语音抢占 → 立即停止并清空队列。
 * 合成失败一律静默（文字仍在对话里）。
 */
import type { TTSSpeakResult } from '@nomi-ai/types';

import { resolvePrefsForCharacter } from '../characterVoice';
import { isMascotMuted } from '../presence';
import { registerSpeechStopper } from '../speechStop';

import { playSynthesized, stopSpeaking } from './audioPlayback';

export interface ReplySpeechMessage {
  op?: unknown;
  id?: unknown;
  text?: unknown;
}

interface Deps {
  synth: (text: string) => Promise<TTSSpeakResult | null>;
  play: typeof playSynthesized;
  stopAudio: () => void;
  volume: () => number | undefined;
  muted: () => boolean;
}

interface Item {
  text: string;
  audio: Promise<TTSSpeakResult | null> | null;
}

export class ReplySpeechQueue {
  private id: string | null = null;
  private items: Item[] = [];
  private pumping = false;
  /** 每次停止 +1：旧的循环看到 token 变了就退出 */
  private token = 0;

  constructor(private readonly d: Deps) {}

  get currentId(): string | null {
    return this.id;
  }

  get pending(): number {
    return this.items.length;
  }

  handle(msg: ReplySpeechMessage): void {
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    if (msg.op === 'stop') {
      if (!id || id === this.id) this.stop();
      return;
    }
    if (msg.op !== 'say' || !id || typeof msg.text !== 'string' || !msg.text.trim()) return;
    if (this.d.muted()) return;
    if (id !== this.id) {
      this.stop();
      this.id = id;
    }
    this.items.push({ text: msg.text, audio: null });
    this.prefetch();
    void this.pump();
  }

  /** 停止朗读（只停自己发起的播放：不在朗读时不碰别的语音） */
  stop(): void {
    const wasActive = this.id !== null && (this.pumping || this.items.length > 0);
    this.token++;
    this.items = [];
    this.id = null;
    this.pumping = false;
    if (wasActive) this.d.stopAudio();
  }

  private prefetch(): void {
    // 只预取队首（正在播放那句的下一句），不多占网络
    const it = this.items[0];
    if (it) it.audio ??= this.d.synth(it.text).catch(() => null);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const token = this.token;
    try {
      while (token === this.token && this.items.length) {
        this.prefetch();
        const item = this.items[0]!;
        const r = await item.audio!;
        if (token !== this.token) return;
        this.items.shift();
        this.prefetch(); // 播这一句的同时合成下一句
        if (!r?.success || !r.audioBase64) {
          // 失败：静默放弃这条回复剩下的部分
          this.items = [];
          break;
        }
        const started = await this.d.play(r, { volume: this.d.volume() });
        if (token !== this.token) return;
        if (!started) {
          this.items = [];
          break;
        }
        const how = await started.done;
        if (token !== this.token) return;
        if (how === 'interrupted') {
          // 被别的语音（或打断）抢占：这条回复不再继续
          this.items = [];
          this.id = null;
          break;
        }
      }
    } finally {
      if (token === this.token) this.pumping = false;
    }
  }
}

let queue: ReplySpeechQueue | null = null;

function getQueue(): ReplySpeechQueue {
  if (queue) return queue;
  queue = new ReplySpeechQueue({
    synth: async (text) => {
      const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
      if (!api?.ttsSpeak) return null;
      return api.ttsSpeak({ text });
    },
    play: playSynthesized,
    stopAudio: stopSpeaking,
    volume: () => resolvePrefsForCharacter().volume,
    muted: isMascotMuted,
  });
  const q = queue;
  registerSpeechStopper(() => q.stop());
  return q;
}

export function handleReplySpeech(msg: ReplySpeechMessage): void {
  getQueue().handle(msg);
}
