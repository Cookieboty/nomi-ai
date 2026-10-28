import type { MascotInteractionConfig } from '@nomi-ai/types';

import { api, hasTransport } from '../../services/api';

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

/** 互动设置：本地持久化 + 同步到主进程（MascotWindowController） */
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

  /** 把当前设置推给主进程（启动时调用一次） */
  push(): void {
    if (hasTransport())
      void api.mascot.setInteractionConfig({ ...this.cfg }).catch(() => undefined);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const interactionSettings = new InteractionSettings();
