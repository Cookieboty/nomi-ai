/** 互动设置（与 `@nomi-ai/types` 的 MascotInteractionConfig 同形） */
export interface MascotInteractionConfig {
  clickThrough: boolean;
  gravity: boolean;
  wander: boolean;
  reactions: boolean;
  globalLook: boolean;
  /** 在气泡里显示 AI 回复摘要（渲染进程本地设置） */
  bubbleReplies: boolean;
}

const KEY = 'mascot.interaction.v2';

export const DEFAULT_INTERACTION: MascotInteractionConfig = {
  clickThrough: true,
  gravity: false,
  wander: false,
  reactions: true,
  globalLook: true,
  bubbleReplies: true,
};

type Listener = (cfg: MascotInteractionConfig) => void;

/** 设置推给宿主（桌面版：主进程的桌面角色窗口控制器）；宿主启动时注入，没有就只存本地 */
export type InteractionConfigBackend = (cfg: MascotInteractionConfig) => Promise<unknown> | void;

function load(key: string): MascotInteractionConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<MascotInteractionConfig>;
    const out = { ...DEFAULT_INTERACTION };
    for (const k of Object.keys(out) as Array<keyof MascotInteractionConfig>) {
      if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean;
    }
    return out;
  } catch {
    return { ...DEFAULT_INTERACTION };
  }
}

export interface InteractionSettingsOptions {
  /** 持久化用的 localStorage key；`null` = 只在内存里（同一页面再挂的角色） */
  storageKey?: string | null;
}

/** 互动设置：本地持久化 + 经注入的后端同步给宿主。每个运行时一份（runtime.ts） */
export class InteractionSettings {
  private readonly key: string | null;
  private cfg: MascotInteractionConfig;
  private readonly listeners = new Set<Listener>();
  private backend: InteractionConfigBackend | null = null;

  constructor(options: InteractionSettingsOptions = {}) {
    this.key = options.storageKey ?? null;
    this.cfg =
      this.key && typeof localStorage !== 'undefined' ? load(this.key) : { ...DEFAULT_INTERACTION };
  }

  /** 宿主注入推送设置的后端（`null` 取消） */
  setBackend(fn: InteractionConfigBackend | null): void {
    this.backend = fn;
  }

  get(): MascotInteractionConfig {
    return this.cfg;
  }

  set(patch: Partial<MascotInteractionConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    if (this.key) {
      try {
        localStorage.setItem(this.key, JSON.stringify(this.cfg));
      } catch {
        /* 隐私模式等：仅本次生效 */
      }
    }
    this.push();
    for (const l of this.listeners) l(this.cfg);
  }

  /** 把当前设置推给宿主（启动时调用一次） */
  push(): void {
    const backend = this.backend;
    if (!backend) return;
    try {
      void Promise.resolve(backend({ ...this.cfg })).catch(() => undefined);
    } catch {
      /* 推送失败不影响本地设置 */
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** 页面主运行时（`defaultAvatarRuntime`）的互动设置：持久化到 `mascot.interaction.v2` */
export const interactionSettings = new InteractionSettings({ storageKey: KEY });

/** 给页面主运行时注入推送后端（宿主启动时调用） */
export function setInteractionConfigBackend(fn: InteractionConfigBackend | null): void {
  interactionSettings.setBackend(fn);
}
