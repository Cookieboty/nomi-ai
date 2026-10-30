import type { ExpressionDirective } from './expressionDirector';
import { avatarMapping, type AvatarMapping } from './mapping';
import { mascotRegistry, type MascotRegistry } from './MascotBackend';

/** 自动触发的动作至少间隔这么久，避免连续事件导致抽搐 */
export const AUTO_MOTION_COOLDOWN_MS = 6000;

/**
 * 一个运行时的情绪 / 动作状态（表情回落计时器、自动动作冷却）：作用于这个运行时自己的后端与映射，
 * 同一页面的两个角色互不影响（runtime.ts）。
 */
export class AvatarMood {
  private revertTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutoMotionAt = -Infinity;

  constructor(
    private readonly registry: MascotRegistry,
    private readonly mapping: AvatarMapping,
  ) {}

  /**
   * 应用一条指令：情绪经当前映射设置表情（holdMs 后回到 neutral），手势 / 活动经映射按冷却时间
   * 播放动作。没有映射的情绪、手势、活动忽略。
   */
  applyDirective(d: ExpressionDirective | null, now = Date.now()): void {
    if (!d) return;
    const backend = this.registry.current();
    if (!backend) return;
    const expression = this.mapping.emotionTarget(d.expression);
    if (expression) {
      if (this.revertTimer) clearTimeout(this.revertTimer);
      this.revertTimer = null;
      if (d.weight === undefined) backend.setExpression(expression);
      else backend.setExpression(expression, d.weight);
      if (d.holdMs > 0) {
        this.revertTimer = setTimeout(() => {
          const neutral = this.mapping.emotionTarget('neutral');
          if (neutral) this.registry.current()?.setExpression(neutral);
          this.revertTimer = null;
        }, d.holdMs);
      }
    }
    const motion = d.activity
      ? this.mapping.activityTarget(d.activity)
      : d.gesture
        ? this.mapping.gestureTarget(d.gesture)
        : null;
    if (motion && (d.force || now - this.lastAutoMotionAt >= AUTO_MOTION_COOLDOWN_MS)) {
      if (backend.playMotion(motion, { priority: d.priority, hold: d.hold })) {
        this.lastAutoMotionAt = now;
      }
    }
  }

  /**
   * 直接播放引擎里的一个动作（不经映射）：宿主自己的动作菜单列的就是当前后端的动作名。
   * 不受冷却限制。
   */
  playMotionNow(name: string): boolean {
    const ok = this.registry.current()?.playMotion(name) ?? false;
    if (ok) this.lastAutoMotionAt = Date.now();
    return ok;
  }

  /** 显式语义手势（AI 工具 / 托盘 / 内核服务）：经映射，不受冷却限制；没有映射时忽略。 */
  playGesture(name: string): boolean {
    const motion = this.mapping.gestureTarget(name);
    return motion ? this.playMotionNow(motion) : false;
  }

  /** 清掉计时器与冷却（卸载 / 测试） */
  reset(): void {
    this.lastAutoMotionAt = -Infinity;
    if (this.revertTimer) clearTimeout(this.revertTimer);
    this.revertTimer = null;
  }
}

/** 页面主运行时（`defaultAvatarRuntime`）的情绪状态；下面的函数作用于它 */
export const avatarMood = new AvatarMood(mascotRegistry, avatarMapping);

export function applyDirective(d: ExpressionDirective | null, now = Date.now()): void {
  avatarMood.applyDirective(d, now);
}

export function playMotionNow(name: string): boolean {
  return avatarMood.playMotionNow(name);
}

export function playGesture(name: string): boolean {
  return avatarMood.playGesture(name);
}

/** 测试用 */
export function resetMoodForTests(): void {
  avatarMood.reset();
}
