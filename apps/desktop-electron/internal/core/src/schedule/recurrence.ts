/**
 * 重复规则与免打扰时段（纯逻辑，本地时区）。
 */
export type Repeat =
  | { kind: 'daily' }
  | { kind: 'weekdays' }
  | { kind: 'weekly'; days: number[] } // 0=周日 … 6=周六
  | { kind: 'monthly' }
  | { kind: 'interval'; minutes: number };

export const REPEAT_LABEL: Record<Repeat['kind'], string> = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  monthly: '每月',
  interval: '每隔',
};

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function describeRepeat(r: Repeat | undefined): string {
  if (!r) return '不重复';
  switch (r.kind) {
    case 'weekly':
      return `每周${[...r.days]
        .sort()
        .map((d) => WEEK[d])
        .join('、')}`;
    case 'interval':
      return r.minutes % 60 === 0 ? `每 ${r.minutes / 60} 小时` : `每 ${r.minutes} 分钟`;
    default:
      return REPEAT_LABEL[r.kind];
  }
}

export function sanitizeRepeat(raw: unknown): Repeat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  switch (o.kind) {
    case 'daily':
    case 'weekdays':
    case 'monthly':
      return { kind: o.kind };
    case 'weekly': {
      const days = Array.isArray(o.days)
        ? [...new Set(o.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))]
        : [];
      return days.length ? { kind: 'weekly', days: days.sort() } : undefined;
    }
    case 'interval': {
      const m = Number(o.minutes);
      return Number.isFinite(m) && m >= 5
        ? { kind: 'interval', minutes: Math.min(10_080, Math.round(m)) }
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * 下一次发生时间：保持 anchor 的时分（interval 除外），严格晚于 after。
 * monthly：anchor 的日号在短月里取当月最后一天。
 */
export function nextOccurrence(r: Repeat, anchor: number, after: number): number {
  if (r.kind === 'interval') {
    const step = r.minutes * 60_000;
    if (anchor > after) return anchor;
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const a = new Date(anchor);
  const h = a.getHours();
  const mi = a.getMinutes();
  const s = a.getSeconds();
  if (r.kind === 'monthly') {
    const dom = a.getDate();
    const base = new Date(Math.max(after, anchor));
    for (let k = 0; k < 24; k++) {
      const y = base.getFullYear();
      const m = base.getMonth() + k;
      const last = new Date(y, m + 1, 0).getDate();
      const t = new Date(y, m, Math.min(dom, last), h, mi, s).getTime();
      if (t > after && t >= anchor) return t;
    }
    return after + 30 * 86_400_000;
  }
  const start = new Date(Math.max(after, anchor - 1));
  for (let k = 0; k < 15; k++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k, h, mi, s);
    const t = d.getTime();
    if (t <= after || t < anchor) continue;
    const wd = d.getDay();
    if (r.kind === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (r.kind === 'weekly' && !r.days.includes(wd)) continue;
    return t;
  }
  return after + 86_400_000;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" */
  start: string;
  end: string;
}

const toMin = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};
export const validHHMM = (s: unknown): s is string => typeof s === 'string' && toMin(s) !== null;

/** 当前是否处于免打扰；跨午夜（22:00–08:00）也支持 */
export function inQuiet(q: QuietHours, at: number): boolean {
  if (!q.enabled) return false;
  const s = toMin(q.start);
  const e = toMin(q.end);
  if (s === null || e === null || s === e) return false;
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** 免打扰结束的时间点（不在免打扰时返回 at） */
export function quietEndsAt(q: QuietHours, at: number): number {
  if (!inQuiet(q, at)) return at;
  const e = toMin(q.end)!;
  const d = new Date(at);
  let t = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    Math.floor(e / 60),
    e % 60,
  ).getTime();
  if (t <= at) t += 86_400_000;
  return t;
}

/** "HH:MM" + 重复规则 → 第一次运行时间（晚于 now） */
export function firstRun(time: string, r: Repeat, now: number): number {
  const m = toMin(time) ?? 8 * 60;
  const d = new Date(now);
  const anchor = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    Math.floor(m / 60),
    m % 60,
  ).getTime();
  if (r.kind === 'interval') return anchor > now ? anchor : nextOccurrence(r, anchor, now);
  // 让 anchor 当天也能命中：从 anchor-1ms 开始找
  return nextOccurrence(r, anchor, Math.max(now, anchor - 1));
}
