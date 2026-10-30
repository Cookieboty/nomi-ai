/**
 * Mascot 渲染后端抽象。
 *
 * 桌面角色的所有「驱动」（口型、表情、视线、眨眼）都只面向本接口编程；
 * 具体渲染器（Rive 见 backends/rive.ts，分层 2D 见 backends/sprite.ts）在加载模型后
 * 通过所在运行时的 `registry.attach()` 挂上来（runtime.ts；页面主运行时的就是 `mascotRegistry`）。
 */

/** 通用表情名。 */
export type MascotExpression = 'neutral' | 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised';

export const MASCOT_EXPRESSIONS: readonly MascotExpression[] = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
];

export type MascotBackendKind = 'sprite' | 'rive' | 'static';

export interface MascotCapabilities {
  /** 模型实际支持的表情（预设 + 自定义） */
  expressions: string[];
  lipSync: boolean;
  lookAt: boolean;
  blink: boolean;
  /** 可播放的身体动作（空 = 不支持） */
  motions: string[];
}

/** 动作播放选项（2D 骨架）：priority 0 空闲行为 · 1 普通 · 2 互动反应 · 3 任务事件 */
export interface MotionOptions {
  priority?: 0 | 1 | 2 | 3;
  /** 被更高优先级占用时排队，而不是丢弃 */
  queue?: boolean;
  /** 保持末姿态直到 release（仅声明了 hold 的动作） */
  hold?: boolean;
}

export interface MascotBackend {
  readonly kind: MascotBackendKind;
  /** 设置表情；weight 0..1，其它情绪表情会被淡出。'neutral' = 清空情绪。 */
  setExpression(name: MascotExpression | string, weight?: number): void;
  /** 口型张合 0..1（TTS 音量包络驱动）。 */
  setMouthOpen(value: number): void;
  /** 视线目标，归一化屏幕坐标 x,y ∈ [-1, 1]（右/上为正）。 */
  lookAt(x: number, y: number): void;
  /** 立即眨一次眼（后端自身也会随机眨眼）。 */
  blink(): void;
  /** 播放身体动作（'random' = 随机手势）；返回是否找到该动作。opts 仅 2D 骨架使用（优先级 / 排队 / 保持）。 */
  playMotion(name: string, opts?: MotionOptions): boolean;
  /** 说话中（TTS 播放）：基础循环切到说话姿态。 */
  setTalking(talking: boolean): void;
  capabilities(): MascotCapabilities;
  dispose(): void;
}

type Listener = (backend: MascotBackend | null) => void;

export interface MascotRegistryOptions {
  /**
   * 当前后端写到哪（e2e / 调试观察）：页面主运行时写 `<html data-mascot-backend …>`，同一页面再挂的角色
   * 写自己运行时的 dataset，免得互相覆盖。
   */
  dataset?: () => Record<string, string | undefined> | null;
}

/** 一个运行时实例挂载的后端（每个运行时同一时刻只有一个角色）。 */
export class MascotRegistry {
  private backend: MascotBackend | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly options: MascotRegistryOptions = {}) {}

  attach(backend: MascotBackend): () => void {
    this.backend = backend;
    this.emit();
    return () => {
      if (this.backend === backend) {
        this.backend = null;
        this.emit();
      }
    };
  }

  current(): MascotBackend | null {
    return this.backend;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 后端能力变化（例如动作库异步加载完成）时重新广播 */
  refresh(): void {
    this.emit();
  }

  private emit(): void {
    // 供 e2e / 调试观察：<html data-mascot-backend="sprite" data-mascot-lipsync="true">
    const ds = this.options.dataset?.();
    if (ds) {
      const caps = this.backend?.capabilities();
      ds.mascotBackend = this.backend?.kind ?? 'none';
      ds.mascotLipsync = String(!!caps?.lipSync);
      ds.mascotExpressions = caps?.expressions.join(',') ?? '';
      ds.mascotMotions = caps?.motions.join(',') ?? '';
    }
    for (const l of this.listeners) {
      try {
        l(this.backend);
      } catch {
        /* isolate listener error */
      }
    }
  }
}

/** 页面主运行时（`defaultAvatarRuntime`）的后端注册表；再挂角色用 `createAvatarRuntime()` */
export const mascotRegistry = new MascotRegistry({
  dataset: () => (typeof document === 'undefined' ? null : document.documentElement.dataset),
});
