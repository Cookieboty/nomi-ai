/**
 * 桌面物理（纯函数，便于单测）：桌面角色窗口在屏幕工作区内的重力 / 落地 / 反弹 / 撞墙 / 漫步。
 *
 * 坐标：屏幕像素，y 向下。窗口位置 (x, y) 为左上角；角色在窗口内的包围盒 box 由渲染进程上报
 * （脚底 = y + box.bottom）。地面 = 角色水平中心所在显示器工作区的下沿（任务栏 / Dock 之上），
 * 墙 = 所有显示器工作区的最左 / 最右边界（多显示器横向拼接时可跨屏行走）。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** display scale factor (DIP → physical px), when known */
  scaleFactor?: number;
}

/** 角色在窗口内的包围盒（窗口像素） */
export interface CharacterBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type BodyMode = 'idle' | 'held' | 'falling' | 'walking';

export interface BodyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  mode: BodyMode;
  /** 漫步目标（窗口 x） */
  walkTargetX?: number;
}

export interface PhysicsConfig {
  gravity: number; // px/s²
  restitution: number; // 0..1
  groundFriction: number; // 1/s
  airDrag: number; // 1/s
  maxSpeed: number; // px/s
  /** 落地速度超过此值才反弹，否则直接停稳 */
  bounceThreshold: number;
  walkSpeed: number; // px/s
  /** 站立 / 行走时脚下空出超过这么多才开始下落（包围盒随动画轻微变化不会让她“再掉一次”） */
  fallGap: number;
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravity: 1550, // softer fall arc when gravity is enabled
  restitution: 0.18, // less bouncy landing
  groundFriction: 11,
  airDrag: 0.4,
  maxSpeed: 4200,
  bounceThreshold: 320, // more landings settle without a second bounce
  walkSpeed: 70,
  fallGap: 24,
};

export interface PhysicsEnv {
  workAreas: Rect[];
  box: CharacterBox;
  gravity: boolean;
  cfg?: PhysicsConfig;
}

export type PhysicsEvent =
  | { type: 'land'; speed: number }
  | { type: 'bounce'; speed: number }
  | { type: 'wall'; side: 'left' | 'right'; speed: number }
  | { type: 'arrive' };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 角色水平中心（屏幕 x）所在的工作区；不在任何工作区上方时取水平距离最近的一块 */
export function areaUnder(workAreas: Rect[], cx: number): Rect {
  if (!workAreas.length) return { x: 0, y: 0, width: 1920, height: 1080 };
  const inside = workAreas.filter((a) => cx >= a.x && cx < a.x + a.width);
  if (inside.length) {
    // 竖直叠放的多块：取最下面那块的地面会把角色“穿过”上层屏，取最上面一块
    return inside.reduce((a, b) => (b.y < a.y ? b : a));
  }
  const dist = (a: Rect) => (cx < a.x ? a.x - cx : cx - (a.x + a.width));
  return workAreas.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

export function floorFor(workAreas: Rect[], cx: number): number {
  const a = areaUnder(workAreas, cx);
  return a.y + a.height;
}

/**
 * Window top (DIP) that stands feet `bottom` (window px, may be fractional after a resize) on
 * `floor`. The window is positioned in whole pixels (Math.round), so a fractional box bottom
 * (e.g. 674.5) would otherwise put the window half a pixel low and round it 1px below the work
 * area. Snap the feet up to the next whole pixel instead: at most < 1px above the floor.
 */
export function groundY(floor: number, bottom: number): number {
  return floor - Math.ceil(bottom - 1e-6);
}

export function horizontalBounds(workAreas: Rect[]): { min: number; max: number } {
  if (!workAreas.length) return { min: 0, max: 1920 };
  return {
    min: Math.min(...workAreas.map((a) => a.x)),
    max: Math.max(...workAreas.map((a) => a.x + a.width)),
  };
}

/** 角色是否站在地面上（容差 1px） */
export function onFloor(s: BodyState, env: PhysicsEnv): boolean {
  const cx = s.x + (env.box.left + env.box.right) / 2;
  return Math.abs(s.y + env.box.bottom - floorFor(env.workAreas, cx)) <= 1;
}

/** 把位置约束在工作区内（墙 / 地面 / 屏幕顶），用于拖拽和显示器变化 */
export function clampToWorld(s: BodyState, env: PhysicsEnv): BodyState {
  const { min, max } = horizontalBounds(env.workAreas);
  const x = clamp(s.x, min - env.box.left, max - env.box.right);
  const cx = x + (env.box.left + env.box.right) / 2;
  const area = areaUnder(env.workAreas, cx);
  const y = clamp(s.y, area.y - env.box.top, groundY(area.y + area.height, env.box.bottom));
  return { ...s, x, y };
}

/** 单个固定步长 */
export function step(
  s0: BodyState,
  dt: number,
  env: PhysicsEnv,
): { state: BodyState; events: PhysicsEvent[] } {
  const cfg = env.cfg ?? DEFAULT_PHYSICS;
  const events: PhysicsEvent[] = [];
  const s: BodyState = { ...s0 };
  if (s.mode === 'held') return { state: s, events };

  const { min, max } = horizontalBounds(env.workAreas);
  const cx = () => s.x + (env.box.left + env.box.right) / 2;
  const floor = () => floorFor(env.workAreas, cx());
  const feet = () => s.y + env.box.bottom;

  if (s.mode === 'walking') {
    const target = s.walkTargetX ?? s.x;
    const dir = Math.sign(target - s.x);
    s.vx = dir * cfg.walkSpeed;
    s.vy = 0;
    const nx = s.x + s.vx * dt;
    if (dir === 0 || (dir > 0 && nx >= target) || (dir < 0 && nx <= target)) {
      s.x = target;
      s.vx = 0;
      s.mode = 'idle';
      s.walkTargetX = undefined;
      events.push({ type: 'arrive' });
    } else {
      s.x = nx;
    }
  }

  // 脚下没有地面了（走到更低 / 更高的显示器、被拖出后松手、工作区变化）
  if (s.mode === 'idle' || s.mode === 'walking') {
    if (feet() < floor() - cfg.fallGap) {
      if (env.gravity) {
        s.mode = 'falling';
      } else {
        s.vx *= Math.exp(-cfg.groundFriction * dt);
        s.vy *= Math.exp(-cfg.groundFriction * dt);
        s.x += s.vx * dt;
        s.y += s.vy * dt;
      }
    } else if (feet() > floor() || (s.mode === 'idle' && feet() < floor())) {
      // 小间隙：贴回地面（不触发下落）
      s.y = groundY(floor(), env.box.bottom);
    }
    if (s.mode === 'idle' && env.gravity) {
      s.vx *= Math.exp(-cfg.groundFriction * dt);
      if (Math.abs(s.vx) < 2) s.vx = 0;
      s.x += s.vx * dt;
    }
  }

  if (s.mode === 'falling') {
    s.vy += cfg.gravity * dt;
    const drag = Math.exp(-cfg.airDrag * dt);
    s.vx *= drag;
    const sp = Math.hypot(s.vx, s.vy);
    if (sp > cfg.maxSpeed) {
      s.vx *= cfg.maxSpeed / sp;
      s.vy *= cfg.maxSpeed / sp;
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    const f = floor();
    if (feet() >= f) {
      s.y = groundY(f, env.box.bottom);
      const impact = s.vy;
      if (impact > cfg.bounceThreshold) {
        s.vy = -impact * cfg.restitution;
        s.vx *= 0.8;
        events.push({ type: 'bounce', speed: impact });
      } else {
        s.vy = 0;
        s.mode = 'idle';
        events.push({ type: 'land', speed: impact });
      }
    }
    // 屏幕顶（扔上去别飞出屏幕）
    const area = areaUnder(env.workAreas, cx());
    if (s.y + env.box.top < area.y) {
      s.y = area.y - env.box.top;
      s.vy = Math.abs(s.vy) * cfg.restitution;
    }
  }

  // 左右墙
  if (s.x + env.box.left < min) {
    s.x = min - env.box.left;
    if (s.vx < 0) {
      events.push({ type: 'wall', side: 'left', speed: -s.vx });
      s.vx = -s.vx * cfg.restitution;
    }
    if (s.mode === 'walking') s.walkTargetX = s.x;
  } else if (s.x + env.box.right > max) {
    s.x = max - env.box.right;
    if (s.vx > 0) {
      events.push({ type: 'wall', side: 'right', speed: s.vx });
      s.vx = -s.vx * cfg.restitution;
    }
    if (s.mode === 'walking') s.walkTargetX = s.x;
  }
  return { state: s, events };
}

/** 固定步长推进：返回剩余累积时间，避免帧率抖动影响物理 */
export function advance(
  s: BodyState,
  accumulator: number,
  env: PhysicsEnv,
  fixedDt = 1 / 120,
  maxSteps = 24,
): { state: BodyState; accumulator: number; events: PhysicsEvent[] } {
  let state = s;
  const events: PhysicsEvent[] = [];
  let acc = Math.min(accumulator, fixedDt * maxSteps);
  while (acc >= fixedDt - 1e-9) {
    const r = step(state, fixedDt, env);
    state = r.state;
    events.push(...r.events);
    acc = Math.max(0, acc - fixedDt);
  }
  return { state, accumulator: acc, events };
}

/** 拖拽速度估计：指数加权，松手时作为抛出速度 */
export class VelocityTracker {
  vx = 0;
  vy = 0;
  private last: { x: number; y: number; t: number } | null = null;

  constructor(private readonly smoothing = 0.06) {}

  reset(x: number, y: number, t: number): void {
    this.last = { x, y, t };
    this.vx = 0;
    this.vy = 0;
  }

  sample(x: number, y: number, t: number): void {
    if (!this.last) {
      this.reset(x, y, t);
      return;
    }
    const dt = (t - this.last.t) / 1000;
    if (dt <= 0) return;
    const k = 1 - Math.exp(-dt / this.smoothing);
    this.vx += ((x - this.last.x) / dt - this.vx) * k;
    this.vy += ((y - this.last.y) / dt - this.vy) * k;
    this.last = { x, y, t };
  }

  /** 松手时：超过 maxAge 没动过就视为静止 */
  release(t: number, maxSpeed = DEFAULT_PHYSICS.maxSpeed, maxAge = 80): { vx: number; vy: number } {
    if (!this.last || t - this.last.t > maxAge) return { vx: 0, vy: 0 };
    const sp = Math.hypot(this.vx, this.vy);
    const k = sp > maxSpeed ? maxSpeed / sp : 1;
    return { vx: this.vx * k, vy: this.vy * k };
  }
}

/** 漫步目标：在当前工作区内随机挑一个点（至少走 minDist） */
export function pickWanderTarget(
  s: BodyState,
  env: PhysicsEnv,
  rnd: () => number,
  minDist = 80,
  maxDist = 360,
): number {
  const cxOff = (env.box.left + env.box.right) / 2;
  const area = areaUnder(env.workAreas, s.x + cxOff);
  const lo = area.x - env.box.left;
  const hi = area.x + area.width - env.box.right;
  const dir = rnd() < 0.5 ? -1 : 1;
  const dist = minDist + rnd() * (maxDist - minDist);
  let t = s.x + dir * dist;
  if (t < lo || t > hi) t = s.x - dir * dist;
  return clamp(t, lo, hi);
}

/**
 * 渲染进程上报的新包围盒（动画 / 换模型 / 缩放导致）：站在地上时保持脚底贴地，
 * 而不是让她因为“脚底抬高了几像素”重新掉落。空中 / 被拎着时不处理。
 */
export function anchorOnBoxChange(
  s: BodyState,
  prev: CharacterBox | null,
  next: CharacterBox,
  workAreas: Rect[],
): BodyState {
  if (!prev || (s.mode !== 'idle' && s.mode !== 'walking')) return s;
  const cxPrev = s.x + (prev.left + prev.right) / 2;
  const floorPrev = floorFor(workAreas, cxPrev);
  const grounded = Math.abs(s.y + prev.bottom - floorPrev) <= 2;
  if (!grounded) return s;
  const cx = s.x + (next.left + next.right) / 2;
  return { ...s, y: groundY(floorFor(workAreas, cx), next.bottom), vy: 0 };
}

/** 启动 / 首次拿到包围盒时：只有明显悬空（> fallGap）才自然下落 */
export function shouldFallAtStart(s: BodyState, env: PhysicsEnv): boolean {
  if (!env.gravity || s.mode !== 'idle') return false;
  const cfg = env.cfg ?? DEFAULT_PHYSICS;
  const cx = s.x + (env.box.left + env.box.right) / 2;
  return floorFor(env.workAreas, cx) - (s.y + env.box.bottom) > cfg.fallGap;
}
