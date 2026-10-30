import type { AvatarInteractionEvent } from '../host';
import { mascotRegistry, type MascotRegistry } from '../MascotBackend';

import { reactionFor, type ReactionKind } from './gestures';
import type { BodyRegion } from './regions';
import { interactionSettings, type InteractionSettings } from './settings';

/** 这些反应的台词还要朗读（悬停类只显示气泡） */
export const SPEAK_KINDS: readonly ReactionKind[] = ['click', 'double', 'pat', 'land', 'grab'];

/** 一个运行时的互动反应状态（冷却按运行时算，两个角色互不影响） */
export class AvatarReactions {
  private token = 0;
  private lastAt = 0;
  private readonly lastByKey = new Map<string, number>();

  constructor(
    private readonly registry: MascotRegistry,
    private readonly settings: InteractionSettings,
    /** 最近一次反应写到哪（运行时的 dataset；页面主运行时是 `<html data-mascot-reaction>`，e2e 观察用） */
    private readonly dataset: () => Record<string, string | undefined> | null = () => null,
  ) {}

  /**
   * 执行一次互动反应：表情 + 动作在这里做；台词（气泡，点击类再朗读）经 `emit` 交给宿主。
   * cooldown：同一 (kind, region) 的最小间隔，避免悬停时刷屏。
   */
  react(
    kind: ReactionKind,
    region: BodyRegion | 'any' = 'any',
    cooldownMs = 0,
    emit?: (event: AvatarInteractionEvent) => void,
  ): boolean {
    if (!this.settings.get().reactions) return false;
    const now = performance.now();
    const key = `${kind}:${region}`;
    // 点击类也有最小间隔（连点不会让角色抽搐）
    const cd = Math.max(cooldownMs, kind === 'hover' ? 0 : 900);
    if (now - (this.lastByKey.get(key) ?? -Infinity) < cd) return false;
    // 悬停类反应之间至少隔 6s，且刚有任何反应时不打断
    if (kind === 'hover' && now - this.lastAt < 6000) return false;
    const r = reactionFor(kind, region);
    if (!r) return false;
    this.lastByKey.set(key, now);
    this.lastAt = now;
    const backend = this.registry.current();
    const my = ++this.token;
    if (r.expression) {
      backend?.setExpression(r.expression);
      setTimeout(
        () => {
          if (this.token === my) this.registry.current()?.setExpression('neutral');
        },
        (r.expressionHold ?? 2) * 1000,
      );
    }
    // 互动反应优先级 2：高于空闲 / 普通动作，低于任务事件
    if (r.motion) backend?.playMotion(r.motion, { priority: 2 });
    const line = r.lines.length ? r.lines[Math.floor(Math.random() * r.lines.length)] : undefined;
    emit?.({
      kind,
      region,
      ...(line ? { line } : {}),
      speak: !!line && SPEAK_KINDS.includes(kind),
    });
    const ds = this.dataset();
    if (ds) ds.mascotReaction = key;
    return true;
  }
}

/** 页面主运行时（`defaultAvatarRuntime`）的互动反应 */
export const avatarReactions = new AvatarReactions(mascotRegistry, interactionSettings, () =>
  typeof document === 'undefined' ? null : document.documentElement.dataset,
);

export function react(
  kind: ReactionKind,
  region: BodyRegion | 'any' = 'any',
  cooldownMs = 0,
  emit?: (event: AvatarInteractionEvent) => void,
): boolean {
  return avatarReactions.react(kind, region, cooldownMs, emit);
}
