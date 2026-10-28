import type { ExpressionDirective } from './expressionDirector';
import { mascotRegistry } from './MascotBackend';

let revertTimer: ReturnType<typeof setTimeout> | null = null;
let lastAutoMotionAt = -Infinity;

/** 自动触发的动作至少间隔这么久，避免连续事件导致抽搐 */
export const AUTO_MOTION_COOLDOWN_MS = 6000;

/** 应用一条表情指令：设置表情（holdMs 后回到 neutral），并按冷却时间播放附带的动作。 */
export function applyDirective(d: ExpressionDirective | null, now = Date.now()): void {
  if (!d) return;
  const backend = mascotRegistry.current();
  if (!backend) return;
  if (revertTimer) clearTimeout(revertTimer);
  revertTimer = null;
  backend.setExpression(d.expression);
  if (d.holdMs > 0) {
    revertTimer = setTimeout(() => {
      mascotRegistry.current()?.setExpression('neutral');
      revertTimer = null;
    }, d.holdMs);
  }
  if (d.motion && (d.force || now - lastAutoMotionAt >= AUTO_MOTION_COOLDOWN_MS)) {
    if (backend.playMotion(d.motion, { priority: d.priority, hold: d.hold }))
      lastAutoMotionAt = now;
  }
}

/** 显式指令（AI 工具 / 托盘 / 工具栏）：不受冷却限制。 */
export function playMotionNow(name: string): boolean {
  const ok = mascotRegistry.current()?.playMotion(name) ?? false;
  if (ok) lastAutoMotionAt = Date.now();
  return ok;
}

/** 测试用 */
export function resetMoodForTests(): void {
  lastAutoMotionAt = -Infinity;
  if (revertTimer) clearTimeout(revertTimer);
  revertTimer = null;
}
