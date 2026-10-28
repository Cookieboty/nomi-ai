import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import { AvatarKey, type AvatarTouchPayload } from '../seams/avatar';

export interface TouchInjectPluginConfig {
  /** 同一 hitArea 冷却时间（ms），默认 5000 */
  cooldownMs?: number;
  /** sensory channel 名，默认 'touch' */
  channel?: string;
  /** 允许的 hitArea 列表；null 表示不限制 */
  hitAreaWhitelist?: string[] | null;
}

/**
 * 插件事件：把渲染进程感官（触摸）注入到当前 agent 会话。
 *
 * P5/P6 agent runtime 订阅本事件，转成 `session.inject({ type: 'sensory', ... })`。
 * 保留本层解耦：本 bundle 不假设 agent runtime 的具体形状。
 */
export const AgentSensoryInjectEvent = 'agent/sensory-inject' as const;

export interface AgentSensoryInjectPayload {
  channel: string;
  data: {
    area: string;
    at: number;
    x?: number;
    y?: number;
  };
}

/**
 * 冷却窗口：为每个 hitArea 记录上次 inject 的 timestamp，
 * 5s 内同 area 的触摸直接丢弃。exported for test.
 */
export class TouchCooldown {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  tryAdmit(area: string, now: number): boolean {
    const prev = this.last.get(area);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.last.set(area, now);
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}

const disposers = new WeakMap<PluginContext, () => void>();

export const TouchInjectPlugin = definePlugin<TouchInjectPluginConfig>({
  name: 'TouchInjectPlugin',
  requires: ['AvatarSeamPlugin'],
  apply(ctx: PluginContext, cfg: TouchInjectPluginConfig) {
    const avatar = ctx.inject(AvatarKey);
    if (!avatar) {
      ctx.logger.warn('[TouchInjectPlugin] ctx.avatar not available; skipping');
      return;
    }

    const cooldown = new TouchCooldown(cfg.cooldownMs ?? 5_000);
    const channel = cfg.channel ?? 'touch';
    const whitelist = cfg.hitAreaWhitelist ?? null;

    const off = avatar.on('touch', (payload: AvatarTouchPayload) => {
      if (whitelist && !whitelist.includes(payload.hitArea)) {
        ctx.logger.debug(`[TouchInjectPlugin] area not whitelisted: ${payload.hitArea}`);
        return;
      }
      if (!cooldown.tryAdmit(payload.hitArea, payload.at)) {
        ctx.logger.debug(`[TouchInjectPlugin] cooldown, drop touch: ${payload.hitArea}`);
        return;
      }
      const injectPayload: AgentSensoryInjectPayload = {
        channel,
        data: {
          area: payload.hitArea,
          at: payload.at,
          x: payload.x,
          y: payload.y,
        },
      };
      ctx.emit<AgentSensoryInjectPayload>(AgentSensoryInjectEvent, injectPayload);
      ctx.logger.info(`[TouchInjectPlugin] injected touch: ${payload.hitArea}`);
    });

    disposers.set(ctx, () => {
      off();
      cooldown.reset();
    });

    ctx.logger.info(
      `TouchInjectPlugin ready (cooldownMs=${cfg.cooldownMs ?? 5000}, channel=${channel})`,
    );
  },
  dispose(ctx: PluginContext) {
    disposers.get(ctx)?.();
    disposers.delete(ctx);
  },
});
