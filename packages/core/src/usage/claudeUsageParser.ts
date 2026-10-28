/**
 * 解析 `claude -p /usage --output-format json` 的输出。
 *
 * 输出是官方 JSON 信封：`result` 是人读文本，订阅账号会有
 *   Current session: 12% used · resets 3pm (Asia/Shanghai)
 *   Current week (all models): 40% used · resets Oct 20, 3pm (Asia/Shanghai)
 * 这样的行；重置时间是自然语言（可能带 IANA 时区，可能跨夏令时），这里换算成时间戳。
 * 取不到就返回空，不猜。
 */
import type { QuotaWindow } from './quota';

const HOUR_MS = 3_600_000;
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

/** 账号 / 额度被拒的文字线索（出现 = 认证失效类，不是暂时性失败） */
const DENIED_HINTS = [
  'unauthorized',
  'forbidden',
  'signed out',
  'not signed in',
  'not logged in',
  'please run /login',
  'sign-in expired',
  'sign-in has expired',
  'authentication failed',
  'authentication required',
  'invalid token',
  'invalid access token',
  'invalid api key',
];

/** 「这个版本 / 模式下没有 /usage」的线索 */
const UNSUPPORTED_HINTS = [
  'unknown skill',
  'unknown command',
  'unknown slash command',
  "isn't available in this environment",
  'is not available in this environment',
  'not available in non-interactive',
];

// eslint-disable-next-line no-control-regex -- 匹配 ANSI 转义序列（ESC）
const stripAnsi = (s: string) => s.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');

function deniedText(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(?:401|403)\b/.test(lower) || DENIED_HINTS.some((h) => lower.includes(h));
}

function formatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
}

/** 某个时刻在指定时区的「墙上时钟」，表示成 UTC 时间戳 */
function wallClock(f: Intl.DateTimeFormat, instant: number): number {
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** 墙上时钟 → 真实时刻（夏令时回拨时可能有两个，缺失时为空） */
function resolveClock(f: Intl.DateTimeFormat, clock: number): number[] {
  const found = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const probe = clock + h * HOUR_MS;
    const offset = wallClock(f, probe) - probe;
    const instant = clock - offset;
    if (wallClock(f, instant) === clock) found.add(instant);
  }
  return [...found];
}

/**
 * 「3pm (Asia/Shanghai)」「Oct 20, 3pm (America/New_York)」「Oct 20 at 3:30pm」→ ms 时间戳。
 * spanHours：窗口长度，用来在候选里挑「接下来最近的那个」。
 */
export function parseClaudeResetTime(input: string, now: number, spanHours: number): number | null {
  if (!Number.isFinite(now)) return null;
  let text = input.trim();
  let f = formatter(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const zs = text.lastIndexOf('(');
  if (zs >= 0 && text.endsWith(')')) {
    try {
      f = formatter(text.slice(zs + 1, -1));
    } catch {
      /* 不认识的时区：用系统时区 */
    }
    text = text.slice(0, zs).trim();
  }
  const clock = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (!clock) return null;
  const hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const h24 = (hour % 12) + (clock[3]!.toLowerCase() === 'pm' ? 12 : 0);
  const dateText = text
    .slice(0, clock.index)
    .replace(/(?:\s+at|,)\s*$/, '')
    .trim();
  const today = new Date(wallClock(f, now));
  const cands: number[] = [];
  let explicitYear = false;
  if (dateText) {
    const m = /^(\w{3})\w*\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(dateText);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1]!.toLowerCase());
    const day = Number(m[2]);
    if (month < 0 || day < 1) return null;
    explicitYear = !!m[3];
    const y = today.getUTCFullYear();
    for (const yy of explicitYear ? [Number(m[3])] : [y - 1, y, y + 1]) {
      const stamp = Date.UTC(yy, month, day, h24, minute);
      const d = new Date(stamp);
      if (d.getUTCMonth() === month && d.getUTCDate() === day)
        cands.push(...resolveClock(f, stamp));
    }
  } else {
    for (let off = -2; off <= 2; off++)
      cands.push(
        ...resolveClock(
          f,
          Date.UTC(
            today.getUTCFullYear(),
            today.getUTCMonth(),
            today.getUTCDate() + off,
            h24,
            minute,
          ),
        ),
      );
  }
  cands.sort((a, b) => a - b);
  const horizon = now + (spanHours + 2) * HOUR_MS;
  const upcoming = cands.find((x) => x >= now && x <= horizon);
  const recent = dateText ? cands.find((x) => x >= now - 24 * HOUR_MS && x <= horizon) : undefined;
  const previous = cands.filter((x) => x < now).at(-1);
  // 带日期但没写年份时，不回退到「去年 / 很久以前」的候选
  const chosen = explicitYear
    ? cands[0]
    : (upcoming ?? recent ?? (dateText ? undefined : previous));
  return chosen === undefined ? null : chosen;
}

export interface ParsedClaudeUsage {
  windows: QuotaWindow[];
  /** 文字里出现账号 / 授权被拒 */
  denied: boolean;
  /** 官方信封标了 is_error，或根本不是可解析的输出 */
  isError: boolean;
  /** 这个 CLI 版本 / 模式不认识 /usage（要安静降级） */
  unsupported: boolean;
}

const SESSION_LABELS = ['current session'];
const WEEK_LABELS = ['current week (all models)', 'current week'];

export function parseClaudeUsageResult(output: string, now: number): ParsedClaudeUsage {
  const bad: ParsedClaudeUsage = { windows: [], denied: false, isError: true, unsupported: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    return { ...bad, denied: deniedText(stripAnsi(output)) };
  }
  if (Array.isArray(decoded))
    decoded = decoded.filter((x) => x && typeof x === 'object' && x.type === 'result').at(-1);
  if (!decoded || typeof decoded !== 'object') return bad;
  const env = decoded as Record<string, unknown>;
  if (typeof env.result !== 'string') return bad;
  const text = stripAnsi(env.result);
  const lower = text.toLowerCase();
  // 官方：本地命令的信封里 local_command = "usage"、没有产生对话轮次；否则说明被当成了普通提示
  const notLocal =
    env.local_command !== 'usage' && typeof env.num_turns === 'number' && env.num_turns > 0;
  const unsupported = notLocal || UNSUPPORTED_HINTS.some((h) => lower.includes(h));
  const denied = !unsupported && deniedText(text);
  const windows = new Map<string, QuotaWindow>();
  if (!denied && !unsupported) {
    for (const line of text.split('\n')) {
      const sep = line.indexOf(':');
      if (sep < 0) continue;
      const label = line.slice(0, sep).trim().toLowerCase();
      const session = SESSION_LABELS.includes(label);
      if (!session && !WEEK_LABELS.includes(label)) continue;
      const frags = line
        .slice(sep + 1)
        .split('·')
        .map((x) => x.trim());
      const pct = /^(\d+(?:\.\d+)?)%(?:\s+used)?$/i.exec(frags[0] ?? '');
      if (!pct) continue;
      const v = Number(pct[1]);
      if (!Number.isFinite(v)) continue;
      const id = session ? 'five_hour' : 'seven_day';
      if (windows.has(id)) continue;
      const reset = frags.find((x) => /^resets\s/i.test(x));
      const resetAt = reset
        ? parseClaudeResetTime(reset.replace(/^resets\s+/i, ''), now, session ? 5 : 168)
        : null;
      windows.set(id, {
        id,
        usedPercent: Math.max(0, Math.min(100, v)),
        windowMinutes: session ? 300 : 10080,
        ...(resetAt ? { resetAt } : {}),
      });
    }
  }
  return {
    windows: ['five_hour', 'seven_day'].flatMap((k) => windows.get(k) ?? []),
    denied,
    isError: env.is_error === true,
    unsupported,
  };
}
