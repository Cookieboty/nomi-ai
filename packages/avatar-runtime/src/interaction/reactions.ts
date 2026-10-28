import type { AvatarInteractionEvent } from '../host';
import { mascotRegistry } from '../MascotBackend';

import { reactionFor, type ReactionKind } from './gestures';
import type { BodyRegion } from './regions';
import { interactionSettings } from './settings';

/** 这些反应的台词还要朗读（悬停类只显示气泡） */
export const SPEAK_KINDS: readonly ReactionKind[] = ['click', 'double', 'pat', 'land', 'grab'];
let token = 0;
let lastAt = 0;
const lastByKey = new Map<string, number>();

/**
 * 执行一次互动反应：表情 + 动作在这里做；台词（气泡，点击类再朗读）经 `emit` 交给宿主。
 * cooldown：同一 (kind, region) 的最小间隔，避免悬停时刷屏。
 */
export function react(
  kind: ReactionKind,
  region: BodyRegion | 'any' = 'any',
  cooldownMs = 0,
  emit?: (event: AvatarInteractionEvent) => void,
): boolean {
  if (!interactionSettings.get().reactions) return false;
  const now = performance.now();
  const key = `${kind}:${region}`;
  // 点击类也有最小间隔（连点不会让她抽搐）
  const cd = Math.max(cooldownMs, kind === 'hover' ? 0 : 900);
  if (now - (lastByKey.get(key) ?? -Infinity) < cd) return false;
  // 悬停类反应之间至少隔 6s，且刚有任何反应时不打断
  if (kind === 'hover' && now - lastAt < 6000) return false;
  const r = reactionFor(kind, region);
  if (!r) return false;
  lastByKey.set(key, now);
  lastAt = now;
  const backend = mascotRegistry.current();
  const my = ++token;
  if (r.expression) {
    backend?.setExpression(r.expression);
    setTimeout(
      () => {
        if (token === my) mascotRegistry.current()?.setExpression('neutral');
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
  document.documentElement.dataset.mascotReaction = key;
  return true;
}
