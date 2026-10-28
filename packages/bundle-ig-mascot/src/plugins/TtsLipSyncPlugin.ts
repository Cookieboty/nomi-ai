import { definePlugin, type HookContext, type PluginContext } from '@nomi-ai/bundle-ig-base';

import { AvatarKey, type AvatarService } from '../seams/avatar';

export interface TtsLipSyncPluginConfig {
  /** 目标嘴型驱动帧率（Hz），默认 20；本 plugin 用最小间隔 = 1000/targetFps 节流 */
  targetFps?: number;
  /** tts 播放结束时是否自动归零并回到 idle 动作，默认 true */
  resetOnEnd?: boolean;
  /** idle 动作 group 名，默认 'idle' */
  idleMotionGroup?: string;
}

/**
 * P3 TtsService 广播的分片，与 seams/tts.ts 中 TtsChunk 同形，本 plugin 只取 `rms`。
 * 为避免 P4 强依赖 electron-caps 类型，这里用 duck-typed 局部接口。
 */
export interface TtsChunkEventPayload {
  reqId: string;
  seq: number;
  rms?: number;
  isFinal?: boolean;
}

export interface TtsEndEventPayload {
  reqId: string;
  interrupted?: boolean;
}

/** 节流器：exported for test。now 由调用方注入以便时间可控。 */
export class RmsThrottler {
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly minGapMs: number) {}

  /**
   * 返回 true 表示"应当立即驱动一次 driveLipSync"。
   * 强制通过场景：isFinal（用户会想看到最终归零）；否则按 minGapMs 节流。
   * 首次调用（lastAt=-Infinity）总是通过。
   */
  admit(now: number, isFinal?: boolean): boolean {
    if (isFinal) {
      this.lastAt = now;
      return true;
    }
    if (now - this.lastAt < this.minGapMs) return false;
    this.lastAt = now;
    return true;
  }

  reset(): void {
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}

const disposers = new WeakMap<PluginContext, () => void>();

export const TtsLipSyncPlugin = definePlugin<TtsLipSyncPluginConfig>({
  name: 'TtsLipSyncPlugin',
  requires: ['AvatarSeamPlugin'],
  apply(ctx: PluginContext, cfg: TtsLipSyncPluginConfig) {
    const avatar: AvatarService | undefined = ctx.inject(AvatarKey);
    if (!avatar) {
      ctx.logger.warn('[TtsLipSyncPlugin] ctx.avatar not available; skipping');
      return;
    }

    const fps = Math.max(1, Math.min(cfg.targetFps ?? 20, 60));
    const gap = Math.floor(1000 / fps);
    const throttler = new RmsThrottler(gap);
    const resetOnEnd = cfg.resetOnEnd ?? true;
    const idleGroup = cfg.idleMotionGroup ?? 'idle';

    const offChunk = ctx.on<TtsChunkEventPayload>(
      'tts/chunk',
      async (hookCtx: HookContext<TtsChunkEventPayload>) => {
        const { rms, isFinal } = hookCtx.payload;
        const now = Date.now();
        if (!throttler.admit(now, isFinal)) return;
        const value = typeof rms === 'number' ? rms : 0;
        avatar.driveLipSync(value);
      },
    );

    const offEnd = ctx.on<TtsEndEventPayload>(
      'tts/end',
      async (_hookCtx: HookContext<TtsEndEventPayload>) => {
        throttler.reset();
        if (!resetOnEnd) return;
        avatar.driveLipSync(0);
        try {
          await avatar.playMotion(idleGroup);
        } catch (err) {
          ctx.logger.debug(`[TtsLipSyncPlugin] fallback to idle failed: ${(err as Error).message}`);
        }
      },
    );

    disposers.set(ctx, () => {
      offChunk();
      offEnd();
      throttler.reset();
    });

    ctx.logger.info(`TtsLipSyncPlugin ready (fps=${fps}, gap=${gap}ms, resetOnEnd=${resetOnEnd})`);
  },
  dispose(ctx: PluginContext) {
    disposers.get(ctx)?.();
    disposers.delete(ctx);
  },
});
