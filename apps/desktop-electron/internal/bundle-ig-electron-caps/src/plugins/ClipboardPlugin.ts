import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import {
  ClipboardKey,
  type ClipboardChangePayload,
  type ClipboardEvent,
  type ClipboardImage,
  type ClipboardService,
} from '../seams/clipboard';

export interface ClipboardPluginConfig {
  /** 变化轮询周期（毫秒），默认 200 */
  pollIntervalMs?: number;
  /** 是否开启轮询（关闭后 on('change') 不会触发） */
  watch?: boolean;
  /** 宿主注入的剪贴板（Electron：`clipboard`）；不给时不提供剪贴板能力 */
  clipboard?: ClipboardApiLike;
}

interface ElectronImageLike {
  isEmpty(): boolean;
  toPNG(): Buffer;
  getSize(): { width: number; height: number };
}

export interface ClipboardApiLike {
  readText(type?: 'clipboard' | 'selection'): string;
  writeText(text: string, type?: 'clipboard' | 'selection'): void;
  readImage(type?: 'clipboard' | 'selection'): ElectronImageLike;
}

type TimerHandle = ReturnType<typeof setInterval>;

function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export class ClipboardServiceImpl implements ClipboardService {
  private lastText: string;
  private lastImageHash: string;
  private timer: TimerHandle | undefined;
  private readonly listeners = new Map<ClipboardEvent, Set<(p: ClipboardChangePayload) => void>>();

  constructor(
    private readonly api: ClipboardApiLike,
    private readonly cfg: Required<Omit<ClipboardPluginConfig, 'clipboard'>>,
    private readonly logger: PluginContext['logger'],
  ) {
    // 建立基线，避免第一次 tick 把"当前状态"误报为 change
    this.lastText = safeRead(() => this.api.readText(), '');
    this.lastImageHash = safeRead(() => this.hashImage(this.api.readImage()), '');
  }

  start(): void {
    if (!this.cfg.watch || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.cfg.pollIntervalMs);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async readText(): Promise<string> {
    return this.api.readText();
  }

  async writeText(text: string): Promise<void> {
    this.api.writeText(text);
    this.lastText = text;
  }

  async readImage(): Promise<ClipboardImage | undefined> {
    const img = this.api.readImage();
    if (img.isEmpty()) return undefined;
    const size = img.getSize();
    return {
      mime: 'image/png',
      data: new Uint8Array(img.toPNG()),
      width: size.width,
      height: size.height,
    };
  }

  on(evt: ClipboardEvent, fn: (p: ClipboardChangePayload) => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt)!.add(fn);
    if (evt === 'change') this.start();
    return () => {
      this.listeners.get(evt)?.delete(fn);
      if (evt === 'change' && this.listeners.get('change')?.size === 0) this.stop();
    };
  }

  /** exposed for test */
  tick(): void {
    try {
      const text = this.api.readText();
      if (text !== this.lastText) {
        this.lastText = text;
        if (text) {
          this.fire('change', { kind: 'text', text });
        } else {
          this.fire('change', { kind: 'empty' });
        }
        return;
      }
      const img = this.api.readImage();
      const hash = this.hashImage(img);
      if (hash !== this.lastImageHash) {
        this.lastImageHash = hash;
        if (!img.isEmpty()) {
          const size = img.getSize();
          this.fire('change', {
            kind: 'image',
            image: {
              mime: 'image/png',
              data: new Uint8Array(img.toPNG()),
              width: size.width,
              height: size.height,
            },
          });
        } else {
          this.fire('change', { kind: 'empty' });
        }
      }
    } catch (err) {
      this.logger.warn('clipboard poll failed', err);
    }
  }

  private hashImage(img: ElectronImageLike): string {
    if (img.isEmpty()) return '';
    const size = img.getSize();
    const buf = img.toPNG();
    return `${size.width}x${size.height}:${buf.length}:${buf.subarray(0, 32).toString('hex')}`;
  }

  private fire(evt: ClipboardEvent, payload: ClipboardChangePayload): void {
    this.listeners.get(evt)?.forEach((fn) => {
      try {
        fn(payload);
      } catch {
        /* ignore listener errors */
      }
    });
  }
}

export const ClipboardPlugin = definePlugin<ClipboardPluginConfig>({
  name: 'ClipboardPlugin',
  apply(ctx: PluginContext, cfg: ClipboardPluginConfig) {
    if (!cfg.clipboard) {
      ctx.logger.warn('ClipboardPlugin skipped: no clipboard injected by the host');
      return;
    }
    const merged: Required<Omit<ClipboardPluginConfig, 'clipboard'>> = {
      pollIntervalMs: cfg.pollIntervalMs ?? 200,
      watch: cfg.watch ?? true,
    };
    const svc = new ClipboardServiceImpl(cfg.clipboard, merged, ctx.logger);
    ctx.provide(ClipboardKey, svc);
    ctx.logger.info(
      `ClipboardPlugin ready (watch=${merged.watch}, poll=${merged.pollIntervalMs}ms)`,
    );
  },
});
