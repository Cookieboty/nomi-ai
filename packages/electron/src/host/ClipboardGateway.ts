/**
 * ClipboardGateway - 基于 Electron `clipboard` 模块实现 ClipboardService
 *
 * Electron ≥ 40 的 clipboard 是 W3C 风格的异步 API（readText/writeText/read 均返回 Promise，
 * 不再提供 readImage）。图像读取：`clipboard.read()` 取 `image/png` Blob，
 * 再借助 nativeImage 获取 width/height。
 * 事件订阅：Electron 未提供剪贴板变化事件，通过 setInterval 轮询文本实现最小版本。
 */

import type {
  ClipboardChangePayload,
  ClipboardEvent,
  ClipboardImage,
  ClipboardService,
} from '@nomi-ai/bundle-ig-electron-caps';
import { clipboard, nativeImage } from 'electron';

export interface ClipboardGatewayOptions {
  /** 轮询间隔，默认 500ms。设为 0 关闭事件订阅（`on()` 会返回 no-op） */
  pollIntervalMs?: number;
}

export class ClipboardGateway implements ClipboardService {
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | undefined;
  private lastText = '';
  private polling = false;
  private readonly listeners = new Set<(p: ClipboardChangePayload) => void>();

  constructor(opts: ClipboardGatewayOptions = {}) {
    this.pollMs = opts.pollIntervalMs ?? 500;
  }

  async readText(): Promise<string> {
    return clipboard.readText();
  }

  async writeText(text: string): Promise<void> {
    await clipboard.writeText(text);
  }

  async readImage(): Promise<ClipboardImage | undefined> {
    const items = await clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    if (!item) return undefined;
    const blob = (await item.getType('image/png')) as Blob;
    const data = new Uint8Array(await blob.arrayBuffer());
    if (data.byteLength === 0) return undefined;
    const size = nativeImage.createFromBuffer(Buffer.from(data)).getSize();
    return { mime: 'image/png', data, width: size.width, height: size.height };
  }

  on(evt: ClipboardEvent, fn: (p: ClipboardChangePayload) => void): () => void {
    if (evt !== 'change') return () => {};
    if (this.pollMs <= 0) return () => {};
    this.listeners.add(fn);
    if (!this.timer) this.startPolling();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private startPolling(): void {
    void clipboard.readText().then(
      (t) => {
        this.lastText = t;
      },
      () => {},
    );
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void this.pollOnce().finally(() => {
        this.polling = false;
      });
    }, this.pollMs);
  }

  private async pollOnce(): Promise<void> {
    let text: string;
    try {
      text = await clipboard.readText();
    } catch {
      return;
    }
    if (text === this.lastText) return;
    this.lastText = text;
    const payload: ClipboardChangePayload =
      text === '' ? { kind: 'empty' } : { kind: 'text', text };
    for (const fn of this.listeners) {
      try {
        fn(payload);
      } catch {
        /* ignore listener error */
      }
    }
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stopPolling();
    this.listeners.clear();
  }
}

/** 内部使用：借助 nativeImage 判断图像是否为空（避免 tree-shake 后无用引用被删） */
export const __nativeImageAvailable = typeof nativeImage !== 'undefined';
