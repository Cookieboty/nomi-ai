import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';
import {
  isSemanticActivity,
  isSemanticEmotion,
  isSemanticGesture,
  type SemanticActivity,
  type SemanticEmotion,
  type SemanticGesture,
} from '@nomi-ai/character-contract';

import {
  AvatarKey,
  type AvatarEvent,
  type AvatarEventPayload,
  type AvatarHost,
  type AvatarReport,
  type AvatarScenePayload,
  type AvatarService,
} from '../seams/avatar';

export interface AvatarSeamPluginConfig {
  /** 若为 true，未挂 host 时 emotion / gesture / activity 会 no-op 而不是抛错。默认 true */
  tolerateNoHost?: boolean;
}

type Listener = (payload: unknown) => void;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/**
 * ctx.avatar 的默认实现（语义事件，§10.5）。
 *
 * 采用 host 注入模式：本 service 不直接引用渲染进程，消费方（主进程）通过
 * `service.attachHost(host)` 传入把语义事件送到角色窗口的实现。未挂 host 时走 warn 兜底，
 * speaking 静默。角色 → AI 的事件经 `report(…)` 进来，由本 service 的 fan-out 表分发。
 */
export class SemanticAvatarService implements AvatarService {
  private host: AvatarHost | undefined;
  private lastScene: AvatarScenePayload | null = null;
  private readonly listeners = new Map<AvatarEvent, Set<Listener>>();

  constructor(
    private readonly logger: PluginContext['logger'],
    private readonly cfg: Required<AvatarSeamPluginConfig>,
    private readonly now: () => number = Date.now,
  ) {}

  hasHost(): boolean {
    return this.host !== undefined;
  }

  attachHost(host: AvatarHost): () => void {
    if (this.host) this.logger.warn('[AvatarSeam] host already attached; replacing');
    this.host = host;
    this.logger.info('[AvatarSeam] host attached');
    return () => {
      if (this.host === host) this.host = undefined;
    };
  }

  async emotion(name: SemanticEmotion, weight?: number): Promise<void> {
    if (!isSemanticEmotion(name)) return this.unknown('emotion', name);
    const w = weight === undefined ? undefined : clamp01(weight);
    await this.call('emotion', { name, weight: w }, (h) => h.emotion(name, w));
  }

  async gesture(name: SemanticGesture): Promise<void> {
    if (!isSemanticGesture(name)) return this.unknown('gesture', name);
    await this.call('gesture', { name }, (h) => h.gesture(name));
  }

  async activity(name: SemanticActivity): Promise<void> {
    if (!isSemanticActivity(name)) return this.unknown('activity', name);
    await this.call('activity', { name }, (h) => h.activity(name));
  }

  speaking(level: number): void {
    if (!this.host) return;
    try {
      this.host.speaking(clamp01(level));
    } catch (err) {
      this.logger.debug(`[AvatarSeam] speaking failed: ${(err as Error).message}`);
    }
  }

  report(event: AvatarReport): void {
    const at = this.now();
    switch (event.type) {
      case 'touched':
        this.fire('touched', { hitbox: event.hitbox, at });
        return;
      case 'clicked':
        this.fire('clicked', {
          hitbox: event.hitbox,
          ...(event.double ? { double: true } : {}),
          at,
        });
        return;
      case 'scene': {
        const { type: _type, ...rest } = event;
        this.lastScene = { ...rest, at };
        this.fire('scene', this.lastScene);
        return;
      }
      default:
        this.logger.warn('[AvatarSeam] unknown report ignored', event);
    }
  }

  scene(): AvatarScenePayload | null {
    return this.lastScene;
  }

  on<E extends AvatarEvent>(evt: E, fn: (p: AvatarEventPayload<E>) => void): () => void {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    const set = this.listeners.get(evt)!;
    set.add(fn as Listener);
    return () => {
      set.delete(fn as Listener);
    };
  }

  private async call(
    op: string,
    arg: unknown,
    run: (host: AvatarHost) => Promise<void>,
  ): Promise<void> {
    if (!this.host) return this.noHost(op, arg);
    try {
      await run(this.host);
    } catch (err) {
      this.logger.warn(`[AvatarSeam] ${op} failed: ${(err as Error).message}`);
    }
  }

  private unknown(op: string, name: unknown): void {
    this.logger.warn(`[AvatarSeam] ${op}: "${String(name)}" is not a semantic name; ignored`);
  }

  private fire(evt: AvatarEvent, payload: unknown): void {
    this.listeners.get(evt)?.forEach((fn) => {
      try {
        fn(payload);
      } catch {
        /* ignore listener errors */
      }
    });
  }

  private noHost(op: string, arg: unknown): void {
    if (this.cfg.tolerateNoHost) {
      this.logger.warn(`[AvatarSeam] no host attached, ${op} noop`, arg);
      return;
    }
    throw new Error(`[AvatarSeam] no host attached for ${op}`);
  }
}

export const AvatarSeamPlugin = definePlugin<AvatarSeamPluginConfig>({
  name: 'AvatarSeamPlugin',
  apply(ctx: PluginContext, cfg: AvatarSeamPluginConfig) {
    const merged: Required<AvatarSeamPluginConfig> = {
      tolerateNoHost: cfg.tolerateNoHost ?? true,
    };
    const svc = new SemanticAvatarService(ctx.logger, merged);
    ctx.provide(AvatarKey, svc);
    ctx.logger.info(`AvatarSeamPlugin ready (tolerateNoHost=${merged.tolerateNoHost})`);
  },
});
