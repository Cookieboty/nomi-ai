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

/** 设置推给宿主（桌面版：主进程的看板娘窗口控制器）；宿主启动时注入，没有就只存本地 */
export type InteractionConfigBackend = (cfg: MascotInteractionConfig) => Promise<unknown> | void;
let backend: InteractionConfigBackend | null = null;

export function setInteractionConfigBackend(fn: InteractionConfigBackend | null): void {
  backend = fn;
}

function load(): MascotInteractionConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<MascotInteractionConfig>;
    const out = { ...DEFAULT_INTERACTION };
    for (const k of Object.keys(out) as Array<keyof MascotInteractionConfig>) {
      if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean;
    }
    return out;
  } catch {
    return { ...DEFAULT_INTERACTION };
  }
}

/** 互动设置：本地持久化 + 经注入的后端同步给宿主 */
class InteractionSettings {
  private cfg: MascotInteractionConfig =
    typeof localStorage === 'undefined' ? { ...DEFAULT_INTERACTION } : load();
  private readonly listeners = new Set<Listener>();

  get(): MascotInteractionConfig {
    return this.cfg;
  }

  set(patch: Partial<MascotInteractionConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.cfg));
    } catch {
      /* 隐私模式等：仅本次生效 */
    }
    this.push();
    for (const l of this.listeners) l(this.cfg);
  }

  /** 把当前设置推给宿主（启动时调用一次） */
  push(): void {
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

export const interactionSettings = new InteractionSettings();
