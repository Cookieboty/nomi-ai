import type { ExpressionDirective } from './expressionDirector';
import { activityTarget, emotionTarget, gestureTarget } from './mapping';
import { mascotRegistry } from './MascotBackend';

let revertTimer: ReturnType<typeof setTimeout> | null = null;
let lastAutoMotionAt = -Infinity;

/** 自动触发的动作至少间隔这么久，避免连续事件导致抽搐 */
export const AUTO_MOTION_COOLDOWN_MS = 6000;

/**
 * 应用一条指令：情绪经当前映射设置表情（holdMs 后回到 neutral），手势 / 活动经映射按冷却时间
 * 播放动作。没有映射的情绪、手势、活动忽略。
 */
export function applyDirective(d: ExpressionDirective | null, now = Date.now()): void {
  if (!d) return;
  const backend = mascotRegistry.current();
  if (!backend) return;
  const expression = emotionTarget(d.expression);
  if (expression) {
    if (revertTimer) clearTimeout(revertTimer);
    revertTimer = null;
    if (d.weight === undefined) backend.setExpression(expression);
    else backend.setExpression(expression, d.weight);
    if (d.holdMs > 0) {
      revertTimer = setTimeout(() => {
        const neutral = emotionTarget('neutral');
        if (neutral) mascotRegistry.current()?.setExpression(neutral);
        revertTimer = null;
      }, d.holdMs);
    }
  }
  const motion = d.activity
    ? activityTarget(d.activity)
    : d.gesture
      ? gestureTarget(d.gesture)
      : null;
  if (motion && (d.force || now - lastAutoMotionAt >= AUTO_MOTION_COOLDOWN_MS)) {
    if (backend.playMotion(motion, { priority: d.priority, hold: d.hold })) lastAutoMotionAt = now;
  }
}

/**
 * 直接播放引擎里的一个动作（不经映射）：宿主自己的动作菜单列的就是当前后端的动作名。
 * 不受冷却限制。
 */
export function playMotionNow(name: string): boolean {
  const ok = mascotRegistry.current()?.playMotion(name) ?? false;
  if (ok) lastAutoMotionAt = Date.now();
  return ok;
}

/** 显式语义手势（AI 工具 / 托盘 / 内核服务）：经映射，不受冷却限制；没有映射时忽略。 */
export function playGesture(name: string): boolean {
  const motion = gestureTarget(name);
  return motion ? playMotionNow(motion) : false;
}

/** 测试用 */
export function resetMoodForTests(): void {
  lastAutoMotionAt = -Infinity;
  if (revertTimer) clearTimeout(revertTimer);
  revertTimer = null;
}
