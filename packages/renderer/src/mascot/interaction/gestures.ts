import type { BodyRegion } from './regions';

/**
 * 摸头检测：光标在头部区域内来回移动（方向反转），1.2s 内反转 ≥ 3 次且幅度 ≥ minAmp 像素即判定为“摸头”。
 */
export class PatDetector {
  private lastX: number | null = null;
  private dir = 0;
  private anchor = 0;
  private flips: number[] = [];

  constructor(
    private readonly minAmp = 10,
    private readonly window = 1200,
    private readonly needed = 3,
  ) {}

  reset(): void {
    this.lastX = null;
    this.dir = 0;
    this.flips = [];
  }

  /** 返回 true 表示刚刚构成一次摸头 */
  feed(x: number, t: number): boolean {
    if (this.lastX === null) {
      this.lastX = x;
      this.anchor = x;
      return false;
    }
    const dx = x - this.lastX;
    this.lastX = x;
    if (dx === 0) return false;
    const d = Math.sign(dx);
    if (this.dir === 0) {
      this.dir = d;
      this.anchor = x - dx;
      return false;
    }
    if (d !== this.dir) {
      if (Math.abs(x - dx - this.anchor) >= this.minAmp) {
        this.flips.push(t);
        this.anchor = x - dx;
      }
      this.dir = d;
    }
    this.flips = this.flips.filter((f) => t - f <= this.window);
    if (this.flips.length >= this.needed) {
      this.flips = [];
      return true;
    }
    return false;
  }
}

/** 单击 / 双击区分：第二次点击在 gap 毫秒内 → 双击，否则 gap 后确认单击 */
export class ClickClassifier {
  private pending: { region: BodyRegion; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly onClick: (region: BodyRegion, kind: 'click' | 'double') => void,
    private readonly gap = 260,
    // 用箭头函数包一层：浏览器里以 timers.set(...) 调用原生 setTimeout 会 Illegal invocation
    private readonly timers: {
      set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clear: (t: ReturnType<typeof setTimeout>) => void;
    } = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (t) => clearTimeout(t),
    },
  ) {}

  click(region: BodyRegion): void {
    if (this.pending) {
      this.timers.clear(this.pending.timer);
      const r = this.pending.region;
      this.pending = null;
      this.onClick(r, 'double');
      return;
    }
    const timer = this.timers.set(() => {
      this.pending = null;
      this.onClick(region, 'click');
    }, this.gap);
    this.pending = { region, timer };
  }

  dispose(): void {
    if (this.pending) this.timers.clear(this.pending.timer);
    this.pending = null;
  }
}

export type ReactionKind =
  'hover' | 'click' | 'double' | 'pat' | 'land' | 'grab' | 'release' | 'wall';

export interface Reaction {
  expression?: string;
  motion?: string;
  lines: string[];
  /** 秒 */
  expressionHold?: number;
}

/** 区域 × 交互 → 反应（表情 + 动作 + 台词）。原创台词，MIT。 */
export const REACTIONS: Partial<
  Record<ReactionKind, Partial<Record<BodyRegion | 'any', Reaction>>>
> = {
  hover: {
    face: {
      expression: 'surprised',
      lines: [],
    },
    skirt: {
      expression: 'angry',
      lines: [],
    },
    hands: { expression: 'happy', lines: [] },
  },
  pat: {
    head: {
      expression: 'happy',
      motion: 'nod',
      lines: [],
      expressionHold: 3,
    },
  },
  click: {
    head: {
      expression: 'relaxed',
      motion: 'nod',
      lines: ['ui.voice-mascot.i-m-listening'],
    },
    face: {
      expression: 'surprised',
      motion: 'flinch',
      lines: [],
    },
    body: {
      expression: 'surprised',
      motion: 'poke',
      lines: [],
    },
    hands: {
      expression: 'happy',
      motion: 'wave',
      lines: [],
    },
    skirt: {
      expression: 'angry',
      motion: 'shake',
      lines: [],
      expressionHold: 3,
    },
    legs: {
      expression: 'sad',
      motion: 'flinch',
      lines: [],
    },
  },
  double: {
    any: {
      expression: 'happy',
      motion: 'clap',
      lines: [],
    },
    skirt: {
      expression: 'angry',
      motion: 'shake',
      lines: [],
      expressionHold: 4,
    },
  },
  grab: {
    any: {
      expression: 'surprised',
      lines: [],
    },
  },
  release: { any: { expression: 'surprised', lines: [] } },
  land: {
    any: {
      expression: 'sad',
      motion: 'flinch',
      lines: [],
    },
  },
  wall: { any: { expression: 'sad', lines: [] } },
};

export function reactionFor(
  kind: ReactionKind,
  region: BodyRegion | 'any' = 'any',
): Reaction | null {
  const table = REACTIONS[kind];
  if (!table) return null;
  return table[region] ?? table.any ?? null;
}
