import type { MascotScaleState } from '@nomi-ai/types';
import { type BrowserWindow, ipcMain, screen } from 'electron';

import {
  advance,
  areaUnder,
  anchorOnBoxChange,
  clampToWorld,
  pickWanderTarget,
  shouldFallAtStart,
  VelocityTracker,
  type BodyState,
  type CharacterBox,
  type PhysicsEnv,
  type PhysicsEvent,
  type Rect,
} from './desktopPhysics';
import {
  DEFAULT_MASCOT_SCALE,
  MASCOT_BASE,
  MASCOT_PAD,
  MASCOT_SCALE_STEP,
  MAX_MASCOT_SCALE,
  MIN_MASCOT_SCALE,
  fitMascotScale,
  maxScaleForArea,
  resizeMascotBounds,
  roundMascotScale,
  stepMascotScale,
  wheelMascotScale,
} from './mascotSize';

export interface InteractionConfig {
  /** 透明区域点击穿透 */
  clickThrough: boolean;
  /** 松手后受重力下落 / 落地 */
  gravity: boolean;
  /** 偶尔沿屏幕底边散步 */
  wander: boolean;
  /** 触摸 / 点击反应 */
  reactions: boolean;
  /** 视线跟随全局鼠标 */
  globalLook: boolean;
}

export const DEFAULT_INTERACTION: InteractionConfig = {
  clickThrough: true,
  gravity: false,
  wander: false,
  reactions: true,
  globalLook: true,
};

export interface MascotScaleHooks {
  /** 用户偏好（持久化值） */
  get(): number;
  /** 用户操作后持久化（主进程防抖落盘） */
  save(scale: number): void;
  /** 状态变化后广播给其它窗口（设置页） */
  changed?(state: MascotScaleState): void;
  /** 允许调用缩放 IPC 的窗口；默认只有看板娘窗口自己 */
  trusted?(sender: Electron.WebContents): boolean;
}

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

const TICK_MS = 1000 / 60;
/** 空闲（无拖拽 / 无物理运动 / 光标静止）时降频，避免 60Hz 永久空转占主线程。
 *  取 ~8Hz：光标“第一动”最长 120ms 后即提频，视线跟随无可察觉延迟 */
const IDLE_TICK_MS = 120;
/** 窗口隐藏 / 最小化时的保活间隔 */
const HIDDEN_TICK_MS = 1000;
/** 最后一次活动后继续保持高频的时长 */
const ACTIVE_HOLD_MS = 400;
/** Linux 用窗口形状做点击穿透（见 setShape） */
const SHAPE_MODE = process.platform === 'linux';
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** 光标同步节流：~30Hz。用时间而非帧计数，保证空闲低频 tick 下移动首帧也能立即发出 */
const CURSOR_MS = 1000 / 30;

/**
 * 看板娘窗口控制器（主进程）：
 * - 全局光标轮询 → 渲染进程（视线跟随 + 逐像素命中测试；Linux 下 forward 不可用也能工作）
 * - 点击穿透：渲染进程回报命中结果后切换 setIgnoreMouseEvents(…, { forward: true })
 * - 拖拽：按住角色移动窗口，速度估计 → 松手抛出
 * - 桌面物理：固定步长重力 / 反弹 / 撞墙 / 多显示器地面 / 随机漫步
 * - 向渲染进程广播窗口运动（速度 / 加速度 / 状态）驱动弹簧骨骼惯性与悬空姿态
 */
export class MascotWindowController {
  private cfg: InteractionConfig = { ...DEFAULT_INTERACTION };
  private body: BodyState = { x: 0, y: 0, vx: 0, vy: 0, mode: 'idle' };
  private box: CharacterBox | null = null;
  private workAreas: Rect[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次活动（拖拽 / 物理运动 / 光标移动）时间，用于空闲降频 */
  private lastActivityAt = 0;
  private last = 0;
  private acc = 0;
  private frame = 0;
  private ignoring = false;
  private hitKnown = false;
  private shapeRects = 0;
  private drag: { dx: number; dy: number } | null = null;
  /** 拖拽中的指针屏幕坐标（渲染进程上报；指针捕获保证窗口移动时仍能收到） */
  private dragPoint: { x: number; y: number } | null = null;
  private readonly tracker = new VelocityTracker();
  private prevV = { vx: 0, vy: 0 };
  private nextWanderAt = 0;
  private lastCursor = { x: NaN, y: NaN };
  private lastCursorAt = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly win: BrowserWindow,
    private readonly logger: Logger,
    private readonly rnd: () => number = Math.random,
    private readonly scaleHooks?: MascotScaleHooks,
  ) {}

  /** 生效缩放（窗口当前大小对应的 scale）与用户偏好（屏幕变小时只临时压低，不改写偏好） */
  private scale = DEFAULT_MASCOT_SCALE;
  private pref = DEFAULT_MASCOT_SCALE;

  start(): void {
    this.refreshDisplays();
    {
      const [w] = this.win.getSize();
      this.scale = roundMascotScale((w - 2 * MASCOT_PAD.x) / MASCOT_BASE.width);
      this.pref = this.scaleHooks?.get() ?? this.scale;
    }
    const [x, y] = this.win.getPosition();
    this.body = { x, y, vx: 0, vy: 0, mode: 'idle' };
    const onDisplays = () => {
      this.refreshDisplays();
      // 屏幕变小 / 拔掉外接屏：临时压低到可见范围；回到大屏后恢复偏好值
      const want = fitMascotScale(this.pref, this.capNow());
      if (want !== this.scale && !this.win.isDestroyed()) this.applyScale(want, false, true);
    };
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
    this.disposers.push(() => {
      screen.removeListener('display-added', onDisplays);
      screen.removeListener('display-removed', onDisplays);
      screen.removeListener('display-metrics-changed', onDisplays);
    });

    const on = (ch: string, fn: (e: Electron.IpcMainEvent, ...a: unknown[]) => void) => {
      const h = (e: Electron.IpcMainEvent, ...a: unknown[]) => {
        if (e.sender === this.win.webContents) fn(e, ...a);
      };
      ipcMain.on(ch, h);
      this.disposers.push(() => ipcMain.removeListener(ch, h));
    };
    on('mascot:hit', (_e, hit) => this.setHit(hit === true));
    on('mascot:shape', (_e, rects) => this.setShape(rects));
    on('mascot:geometry', (_e, box) => this.setBox(box));
    on('mascot:drag-start', (_e, sx, sy) => this.dragStart(num(sx), num(sy)));
    on('mascot:drag-move', (_e, sx, sy) => {
      const x = num(sx);
      const y = num(sy);
      if (this.drag && x !== null && y !== null) this.dragPoint = { x, y };
    });
    on('mascot:drag-end', () => this.dragEnd());
    on('mascot:interaction-config', (_e, cfg) => this.setConfig(cfg));
    on('mascot:wander-now', () => this.startWander());

    // 大小：Ctrl/⌘+滚轮、菜单、设置页滑块、快捷键
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, (e, ...a) => {
        const ok = this.scaleHooks?.trusted
          ? this.scaleHooks.trusted(e.sender)
          : e.sender === this.win.webContents;
        return ok ? fn(...a) : this.scaleState();
      });
      this.disposers.push(() => ipcMain.removeHandler(ch));
    };
    handle('mascot:scale-get', () => this.scaleState());
    handle('mascot:scale-set', (v) =>
      num(v) === null ? this.scaleState() : this.setScale(num(v)!),
    );
    handle('mascot:scale-step', (d) =>
      this.setScale(stepMascotScale(this.scale, d === -1 ? -1 : 1, this.capNow())),
    );
    handle('mascot:scale-wheel', (dy, mode) =>
      num(dy) === null
        ? this.scaleState()
        : this.setScale(wheelMascotScale(this.scale, num(dy)!, num(mode) ?? 0, this.capNow())),
    );
    handle('mascot:scale-reset', () => this.setScale(DEFAULT_MASCOT_SCALE));

    // 只读快照（e2e / 调试）
    ipcMain.removeHandler('mascot:debug-snapshot');
    ipcMain.handle('mascot:debug-snapshot', () => this.snapshot());
    this.disposers.push(() => ipcMain.removeHandler('mascot:debug-snapshot'));
    this.win.on('closed', () => this.dispose());
    // 从隐藏 / 最小化恢复：立即提频，不必等下一个 1s 保活 tick
    const wake = () => {
      if (this.win.isDestroyed()) return;
      this.last = performance.now();
      this.lastActivityAt = this.last;
      this.schedule(TICK_MS);
    };
    this.win.on('show', wake);
    this.win.on('restore', wake);
    this.disposers.push(() => {
      if (this.win.isDestroyed()) return;
      this.win.off('show', wake);
      this.win.off('restore', wake);
    });
    this.last = performance.now();
    this.lastActivityAt = this.last;
    this.nextWanderAt = this.last + 15000;
    this.schedule(TICK_MS);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
    // 定时器不应阻止 app 空闲退出（与其它常驻服务一致）
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const d of this.disposers.splice(0)) d();
  }

  config(): InteractionConfig {
    return { ...this.cfg };
  }

  setConfig(raw: unknown): void {
    const c = (raw ?? {}) as Partial<InteractionConfig>;
    for (const k of Object.keys(DEFAULT_INTERACTION) as Array<keyof InteractionConfig>) {
      if (typeof c[k] === 'boolean') this.cfg[k] = c[k] as boolean;
    }
    if (!this.cfg.clickThrough) {
      this.applyIgnore(false);
      if (SHAPE_MODE) this.setShape([]);
    }
    if (!this.cfg.wander && this.body.mode === 'walking')
      this.body = { ...this.body, mode: 'idle', vx: 0 };
    this.logger.info('Nomi 互动设置', this.cfg);
  }

  /** 角色脚底所在显示器允许的最大缩放 */
  private capNow(): number {
    const [wx] = this.win.getPosition();
    const [w] = this.win.getSize();
    const cx = this.box ? wx + (this.box.left + this.box.right) / 2 : wx + w / 2;
    return maxScaleForArea(this.workAreas.length ? areaUnder(this.workAreas, cx) : null);
  }

  scaleState(): MascotScaleState {
    const [width, height] = this.win.isDestroyed() ? [0, 0] : this.win.getSize();
    return {
      scale: this.scale,
      min: MIN_MASCOT_SCALE,
      max: this.capNow(),
      hardMax: MAX_MASCOT_SCALE,
      default: DEFAULT_MASCOT_SCALE,
      step: MASCOT_SCALE_STEP,
      window: { width, height },
    };
  }

  /** 用户设置大小：夹紧到屏幕范围、保持脚底中心不动、持久化、通知 */
  setScale(raw: number): MascotScaleState {
    return this.applyScale(fitMascotScale(raw, this.capNow()), true, true);
  }

  private applyScale(target: number, userPref: boolean, notify: boolean): MascotScaleState {
    if (this.win.isDestroyed()) return this.scaleState();
    if (userPref) this.pref = target;
    if (target !== this.scale) {
      const b = this.win.getBounds();
      const from = this.scale;
      const feet = this.box
        ? { x: (this.box.left + this.box.right) / 2, y: this.box.bottom }
        : null;
      const nb = resizeMascotBounds({
        bounds: b,
        fromScale: from,
        toScale: target,
        box: this.box,
        workAreas: this.workAreas,
      });
      try {
        // Linux(GTK) 的不可缩放窗口会把尺寸提示锁死；程序化缩放时临时放开
        const lock = process.platform === 'linux' && !this.win.isResizable();
        if (lock) this.win.setResizable(true);
        this.win.setBounds(nb);
        if (lock) this.win.setResizable(false);
      } catch (err) {
        this.logger.warn('缩放看板娘窗口失败', { error: String(err) });
        return this.scaleState();
      }
      const r = target / from;
      if (this.box) {
        const k = (v: number, pad: number, max: number) =>
          Math.max(0, Math.min(max, pad + (v - pad) * r));
        this.box = {
          left: k(this.box.left, MASCOT_PAD.x, nb.width),
          right: k(this.box.right, MASCOT_PAD.x, nb.width),
          top: k(this.box.top, MASCOT_PAD.top, nb.height),
          bottom: k(this.box.bottom, MASCOT_PAD.top, nb.height),
        };
      }
      if (this.drag) {
        // 拖拽中缩放：指针保持在角色同一位置
        this.drag = { dx: this.drag.dx - (nb.x - b.x), dy: this.drag.dy - (nb.y - b.y) };
      }
      this.body = { ...this.body, x: nb.x, y: nb.y };
      this.scale = target;
      this.hitKnown = false;
    }
    const state = this.scaleState();
    if (userPref) this.scaleHooks?.save(this.pref);
    if (notify) {
      this.send('mascot:scale-changed', state);
      this.scaleHooks?.changed?.(state);
    }
    return state;
  }

  private refreshDisplays(): void {
    this.workAreas = screen.getAllDisplays().map((d) => ({ ...d.workArea }));
  }

  private env(): PhysicsEnv | null {
    if (!this.box) return null;
    return { workAreas: this.workAreas, box: this.box, gravity: this.cfg.gravity };
  }

  private setBox(raw: unknown): void {
    const b = raw as Partial<CharacterBox> | null;
    const [w, h] = this.win.getSize();
    if (
      !b ||
      ![b.left, b.right, b.top, b.bottom].every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      return;
    const box = {
      left: Math.max(0, Math.min(w, b.left!)),
      right: Math.max(0, Math.min(w, b.right!)),
      top: Math.max(0, Math.min(h, b.top!)),
      bottom: Math.max(0, Math.min(h, b.bottom!)),
    };
    if (box.right - box.left < 10 || box.bottom - box.top < 10) return;
    const prev = this.box;
    this.box = box;
    if (!prev) {
      // 启动时明显悬空才自然落到地面；贴近地面的直接站稳
      const env = this.env();
      if (env && shouldFallAtStart(this.body, env)) this.body = { ...this.body, mode: 'falling' };
    } else if (!this.drag) {
      // 动画让包围盒变化：站着的她保持脚底贴地，不会“再掉一次”
      this.body = anchorOnBoxChange(this.body, prev, box, this.workAreas);
    }
  }

  /**
   * Linux：X11 下 getCursorScreenPoint 只在光标经过本应用窗口时更新，且不支持 forward，
   * 所以改用窗口形状（setShape）实现点击穿透：渲染进程上报角色 alpha 扫描线 + UI 矩形。
   */
  private setShape(raw: unknown): void {
    if (!SHAPE_MODE || this.win.isDestroyed()) return;
    const [w, h] = this.win.getSize();
    const full = [{ x: 0, y: 0, width: w, height: h }];
    let rects: Array<{ x: number; y: number; width: number; height: number }> = full;
    if (this.cfg.clickThrough && Array.isArray(raw) && raw.length) {
      rects = raw
        .slice(0, 400)
        .map((r) => r as Record<string, unknown>)
        .filter((r) =>
          [r.x, r.y, r.width, r.height].every((v) => typeof v === 'number' && Number.isFinite(v)),
        )
        .map((r) => {
          const x = Math.max(0, Math.min(w, Math.floor(r.x as number)));
          const y = Math.max(0, Math.min(h, Math.floor(r.y as number)));
          return {
            x,
            y,
            width: Math.max(1, Math.min(w - x, Math.ceil(r.width as number))),
            height: Math.max(1, Math.min(h - y, Math.ceil(r.height as number))),
          };
        });
      if (!rects.length) rects = full;
    }
    this.shapeRects = rects === full ? 0 : rects.length;
    try {
      this.win.setShape(rects);
    } catch (err) {
      this.logger.warn('setShape 失败', { error: String(err) });
    }
  }

  private setHit(hit: boolean): void {
    this.hitKnown = true;
    if (SHAPE_MODE) return;
    if (this.drag) return; // 拖拽中始终接收鼠标
    this.applyIgnore(this.cfg.clickThrough && !hit);
  }

  private applyIgnore(ignore: boolean): void {
    if (ignore === this.ignoring || this.win.isDestroyed()) return;
    this.ignoring = ignore;
    if (ignore) this.win.setIgnoreMouseEvents(true, { forward: true });
    else this.win.setIgnoreMouseEvents(false);
  }

  private dragStart(sx: number | null, sy: number | null): void {
    // 立即切回高频，不等下一个空闲 tick（起拖不能有延迟）
    this.lastActivityAt = performance.now();
    this.schedule(TICK_MS);
    const c = sx !== null && sy !== null ? { x: sx, y: sy } : screen.getCursorScreenPoint();
    this.dragPoint = c;
    const [x, y] = this.win.getPosition();
    this.drag = { dx: c.x - x, dy: c.y - y };
    this.applyIgnore(false);
    this.body = { x, y, vx: 0, vy: 0, mode: 'held' };
    this.tracker.reset(x, y, performance.now());
    this.send('mascot:physics-event', { type: 'grab' });
  }

  private dragEnd(): void {
    if (!this.drag) return;
    // 重力只在真正拖拽松手后生效
    this.drag = null;
    const v = this.tracker.release(performance.now());
    if (this.cfg.gravity) {
      this.body = { ...this.body, vx: v.vx, vy: v.vy, mode: 'falling' };
    } else {
      // Free place: stay exactly where dropped (no slide / throw residual)
      this.body = { ...this.body, vx: 0, vy: 0, mode: 'idle' };
    }
    this.send('mascot:physics-event', { type: 'release', vx: v.vx, vy: v.vy });
  }

  private startWander(): void {
    const env = this.env();
    if (!env || this.body.mode !== 'idle') return;
    this.body = {
      ...this.body,
      mode: 'walking',
      walkTargetX: pickWanderTarget(this.body, env, this.rnd),
    };
  }

  private tick(): void {
    if (this.win.isDestroyed()) return this.dispose();
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    // 窗口隐藏 / 最小化：暂停物理与光标同步，仅以低频保活（可见性恢复后立即提速）
    if (!this.win.isVisible() || this.win.isMinimized()) {
      this.schedule(HIDDEN_TICK_MS);
      return;
    }
    this.frame += 1;

    const cursor = screen.getCursorScreenPoint();
    const env = this.env();
    let events: PhysicsEvent[] = [];
    if (this.drag) {
      this.lastActivityAt = now;
      const p = this.dragPoint ?? cursor;
      const tx = p.x - this.drag.dx;
      const ty = p.y - this.drag.dy;
      let next: BodyState = { ...this.body, x: tx, y: ty };
      if (env) next = clampToWorld(next, env);
      this.body = next;
      this.tracker.sample(next.x, next.y, now);
      this.body.vx = this.tracker.vx;
      this.body.vy = this.tracker.vy;
    } else if (env) {
      if (this.cfg.wander && this.body.mode === 'idle' && now >= this.nextWanderAt) {
        this.nextWanderAt = now + 20000 + this.rnd() * 40000;
        this.startWander();
      }
      this.acc += dt;
      const r = advance(this.body, this.acc, env);
      this.body = r.state;
      this.acc = r.accumulator;
      events = r.events;
    }

    const [wx, wy] = this.win.getPosition();
    const nx = Math.round(this.body.x);
    const ny = Math.round(this.body.y);
    if (nx !== wx || ny !== wy) {
      this.win.setPosition(nx, ny);
      this.lastActivityAt = now;
    }

    // 运动状态 → 渲染进程（弹簧骨骼惯性 / 悬空姿态 / 走路动画）
    const ax = (this.body.vx - this.prevV.vx) / Math.max(dt, 1e-3);
    const ay = (this.body.vy - this.prevV.vy) / Math.max(dt, 1e-3);
    this.prevV = { vx: this.body.vx, vy: this.body.vy };
    const moving = this.body.mode !== 'idle' || Math.abs(this.body.vx) + Math.abs(this.body.vy) > 1;
    if (moving) this.lastActivityAt = now;
    if (moving || this.frame % 30 === 0) {
      this.send('mascot:body', {
        mode: this.body.mode,
        vx: this.body.vx,
        vy: this.body.vy,
        ax: Number.isFinite(ax) ? ax : 0,
        ay: Number.isFinite(ay) ? ay : 0,
        dir: Math.sign(this.body.vx),
      });
    }
    for (const e of events) this.send('mascot:physics-event', e);

    const rx = cursor.x - nx;
    const ry = cursor.y - ny;
    if (rx !== this.lastCursor.x || ry !== this.lastCursor.y) {
      // 光标在移动：视线跟随需要，保持高频；静止后自然降到空闲频率。
      // 时间节流（非帧取模），空闲低频下首个移动 tick 也能立即发出，不再丢首帧。
      this.lastActivityAt = now;
      if (now - this.lastCursorAt >= CURSOR_MS || Number.isNaN(this.lastCursor.x)) {
        this.lastCursorAt = now;
        this.lastCursor = { x: rx, y: ry };
        const [w, h] = this.win.getSize();
        this.send('mascot:cursor', {
          x: rx,
          y: ry,
          inside: rx >= 0 && ry >= 0 && rx < w && ry < h,
        });
      }
    }
    // 渲染进程还没回报过命中：保持可交互，避免“点不到”
    if (!this.hitKnown && this.ignoring) this.applyIgnore(false);

    // 自适应调度：拖拽 / 物理运动 / 光标移动后短时间内保持 60Hz，空闲降到 ~8Hz
    const busy = this.drag !== null || moving || now - this.lastActivityAt < ACTIVE_HOLD_MS;
    this.schedule(busy ? TICK_MS : IDLE_TICK_MS);
  }

  private send(ch: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(ch, payload);
  }

  /** 测试 / 调试用 */
  snapshot(): {
    body: BodyState;
    ignoring: boolean;
    shapeRects: number;
    clickThroughMode: 'ignore' | 'shape';
    box: CharacterBox | null;
    cfg: InteractionConfig;
  } {
    return {
      body: { ...this.body },
      ignoring: this.ignoring,
      shapeRects: this.shapeRects,
      clickThroughMode: SHAPE_MODE ? 'shape' : 'ignore',
      box: this.box,
      cfg: this.config(),
    };
  }
}
