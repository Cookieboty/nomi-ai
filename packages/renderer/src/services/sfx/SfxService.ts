/**
 * 桌面角色动作音效：WebAudio 程序合成，设置开关 + 音量。
 * 静音 / 关闭时不发声；默认开启。
 */
import { createLogger } from '@nomi-ai/ui';

import { SYNTH } from './synth';
import type { SfxId, SfxSettings } from './types';

const log = createLogger('sfx');
const STORAGE_KEY = 'mascot.sfx.v1';
/** 最后一个音效之后多久挂起 AudioContext（音效都在 2 秒内放完） */
const SUSPEND_IDLE_MS = 10_000;

export const DEFAULT_SFX: SfxSettings = { enabled: true, volume: 0.7 };

function loadLocal(): Partial<SfxSettings> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SfxSettings>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveLocal(s: SfxSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export class SfxService {
  private settings: SfxSettings = { ...DEFAULT_SFX, ...loadLocal() };
  private ctx: AudioContext | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAt = new Map<string, number>();
  /** 全局静音闸（勿扰 / 主开关关闭时由桥接设置） */
  private muted = false;

  getSettings(): SfxSettings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<SfxSettings>): SfxSettings {
    this.settings = {
      enabled: patch.enabled ?? this.settings.enabled,
      volume: Math.max(0, Math.min(1, patch.volume ?? this.settings.volume)),
    };
    saveLocal(this.settings);
    return this.getSettings();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isPlayable(): boolean {
    return this.settings.enabled && !this.muted && this.settings.volume > 0.001;
  }

  /** 一段时间没有音效就挂起 AudioContext：运行中的上下文让音频线程一直醒着（空闲耗电）；下次 play 时 ensureCtx 恢复 */
  private scheduleSuspend(): void {
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      if (this.ctx?.state === 'running') void this.ctx.suspend().catch(() => undefined);
    }, SUSPEND_IDLE_MS);
  }

  private ensureCtx(): AudioContext | null {
    try {
      if (!this.ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch (e) {
      log.warn('AudioContext unavailable', e);
      return null;
    }
  }

  /**
   * 播放短音效。cooldownMs 防止同 id 刷屏。
   */
  play(id: SfxId, opts: { cooldownMs?: number; volume?: number } = {}): boolean {
    if (!this.isPlayable()) return false;
    const synth = SYNTH[id];
    if (!synth) return false;
    const now = performance.now();
    const cd = opts.cooldownMs ?? 120;
    if (now - (this.lastAt.get(id) ?? -Infinity) < cd) return false;
    const ctx = this.ensureCtx();
    if (!ctx || ctx.state === 'closed') return false;
    this.lastAt.set(id, now);
    const gain = Math.max(0, Math.min(1, opts.volume ?? this.settings.volume));
    try {
      synth(ctx, ctx.currentTime, gain);
      this.scheduleSuspend();
      return true;
    } catch (e) {
      log.warn('play failed', id, e);
      return false;
    }
  }

  /** 测试用 */
  resetCooldowns(): void {
    this.lastAt.clear();
  }
}

export const sfxService = new SfxService();
