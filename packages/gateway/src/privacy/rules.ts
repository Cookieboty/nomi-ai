/**
 * 密钥识别规则（docs/design/secret-privacy.md §5）：网关脱敏、调试追踪、情节记忆共用这一份。
 *
 * - 每条规则带快速标记：文本里一个标记都没有就不跑正则；
 * - 边界用零宽断言写在正则里：紧挨字母数字、`_`、`-` 的不算（长单词中间的片段不是 key）；
 * - 规则只在值落在 id（UUID、32 位以上十六进制）里面时让路（§5.3）。
 * 纯 Node，不依赖 Electron。
 */

/** 规则表版本：规则有改动就加一，命中记录里带上，便于排查误报 */
export const RULES_VERSION = 1;

export type SecretKind =
  'API_KEY' | 'PRIVATE_KEY' | 'TOKEN' | 'PASSWORD' | 'CONNECTION_STRING' | 'CUSTOM';

export interface SecretSpan {
  start: number;
  end: number;
  kind: string;
  /** known = 已知原文 / 已见值；rule = 固定格式；strict = 上下文 + 熵（严格档） */
  by: 'known' | 'rule' | 'strict';
}

interface Rule {
  kind: SecretKind;
  /** 必须带 g 标记；有分组的还要带 d（取分组下标） */
  re: RegExp;
  /** 值是第几个分组（不设 = 整个匹配） */
  group?: number;
  /** 文本里至少有一个（区分大小写） */
  markers: string[];
  /** 文本里还必须都有（连接串的 @） */
  also?: string[];
  /**
   * 匹配离标记多远：正则只在每个标记前 back、后 ahead 个字符的窗口里跑（默认 64 / 512），
   * 长文本里标记很常见（代码里的 nomi-、Bearer、key=）时不用整段扫描
   */
  back?: number;
  ahead?: number;
  ok?: (v: string) => boolean;
  strict?: boolean;
}

/** 示例、模板、打码过的值：不是密钥 */
const DUMMY =
  /^(?:x+|\*+|\.+|password|passwd|pass|secret|token|changeme|example|test|dummy|redacted|your[-_]?[a-z_-]*|<[^>]*>|\$\{?[\w.-]+\}?|%[\w]+%|\{\{[^}]*\}\}|\[[^\]]*\])$/i;

function notDummy(v: string): boolean {
  return !DUMMY.test(v) && !/^(.)\1+$/.test(v);
}

/** 像随机生成的：有字母也有数字，不是示例 */
function secretValue(v: string): boolean {
  return /[A-Za-z]/.test(v) && /\d/.test(v) && notDummy(v);
}

/** 连接串里的密码可以很短，只排除示例和模板 */
function passwordValue(v: string): boolean {
  return v.length >= 4 && notDummy(v) && !/^[$%{<[]/.test(v);
}

/** 香农熵（每字符比特） */
export function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) {
    const p = k / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 严格档的值：够长、够乱，且不是哈希 / UUID / integrity / 数字 */
function strictValue(v: string): boolean {
  if (v.length < 12 || !notDummy(v)) return false;
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(v)) return false;
  if (UUID_ONLY.test(v)) return false;
  if (/^sha(?:1|256|384|512)-/.test(v) || v.startsWith('data:')) return false;
  if (/^\d+$/.test(v)) return false;
  return entropy(v) >= 3;
}

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 前后不能紧挨的字符 */
const B = '(?<![A-Za-z0-9_-])';

const RULES: Rule[] = [
  {
    kind: 'PRIVATE_KEY',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
    markers: ['PRIVATE KEY'],
    ahead: 16_384,
  },
  {
    kind: 'API_KEY',
    re: new RegExp(`${B}sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`, 'g'),
    markers: ['sk-'],
  },
  // 中转站自己的 key：oc_sk_…、or_sk_…
  {
    kind: 'API_KEY',
    re: new RegExp(`${B}[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}`, 'g'),
    markers: ['_sk_'],
    ok: secretValue,
  },
  {
    kind: 'TOKEN',
    re: new RegExp(
      `${B}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})`,
      'g',
    ),
    markers: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-'],
  },
  {
    kind: 'API_KEY',
    re: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`, 'g'),
    markers: ['AIza'],
  },
  {
    kind: 'API_KEY',
    re: new RegExp(`${B}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`, 'g'),
    markers: ['AKIA', 'ASIA'],
  },
  {
    kind: 'TOKEN',
    re: new RegExp(`${B}xox[abpr]-[A-Za-z0-9-]{10,}`, 'g'),
    markers: ['xox'],
    ok: secretValue,
  },
  {
    kind: 'API_KEY',
    re: new RegExp(`${B}(?:hf_[A-Za-z0-9]{30,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,})`, 'g'),
    markers: ['hf_', 'xai-', 'gsk_'],
  },
  // Nomi 自己的客户端令牌、标签令牌
  {
    kind: 'TOKEN',
    re: new RegExp(`${B}nomi-(?:gw|tab)-[A-Za-z0-9_-]{6,}`, 'g'),
    markers: ['nomi-'],
  },
  {
    kind: 'TOKEN',
    re: new RegExp(`${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`, 'g'),
    markers: ['eyJ'],
    ahead: 8192,
  },
  {
    kind: 'TOKEN',
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/dgi,
    group: 1,
    markers: ['Bearer', 'bearer', 'BEARER'],
    ok: secretValue,
  },
  // 连接串与 URL 里的 user:pass@
  {
    kind: 'PASSWORD',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]+:([^\s@/"'`]+)@/dgi,
    group: 1,
    markers: ['://'],
    also: ['@'],
    ok: passwordValue,
  },
  {
    kind: 'TOKEN',
    re: /[?&](?:key|api_key|apikey|access_token|token|client_secret)=([^&\s"'#]{12,})/dgi,
    group: 1,
    markers: ['key=', 'token=', 'secret=', 'KEY=', 'TOKEN=', 'SECRET=', 'Key=', 'Token='],
    ok: secretValue,
  },
  // 严格档：键名像密钥的赋值（.env、YAML、JSON）
  {
    kind: 'PASSWORD',
    re: /(?:^|[\s"'{,;(])((?:[A-Za-z_][A-Za-z0-9_]*?)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|key|token|secret|password|passwd))["']?\s*[:=]\s*["']?([^\s"',;)}]+)/dg,
    group: 2,
    markers: ['=', ':'],
    ok: strictValue,
    strict: true,
  },
];

/** 严格档的键名里，指的是 id、游标、摘要而不是凭据的 */
const NOT_CREDENTIAL_NAME =
  /(?:_id|id|_hash|hash|page_?token|next_?token|csrf_?token|idempotency_?key|_?keys?_?count)$/i;

const ID_RE =
  /(?<![0-9A-Za-z])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-fA-F]{32,})(?![0-9A-Za-z])/g;

/** 文本里 id 的区间：落在它们里面的规则命中让路（§5.3） */
function idRanges(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of s.matchAll(ID_RE)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** 标记 → 用到它的规则（严格档的 = 和 : 太常见，不走这里） */
const BY_MARKER = new Map<string, Rule[]>();
for (const r of RULES)
  if (!r.strict) for (const m of r.markers) BY_MARKER.set(m, [...(BY_MARKER.get(m) ?? []), r]);

/** 一遍扫出所有标记（大小写不敏感，再按原样核对），比逐个 includes 快 */
const MARKER_RE = new RegExp(
  [...new Set([...BY_MARKER.keys()].map((m) => m.toLowerCase()))]
    .sort((a, b) => b.length - a.length)
    .map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('|'),
  'gi',
);

/** 每条规则的标记出现在哪些位置 */
function markerHits(s: string): Map<Rule, Array<[number, number]>> {
  const out = new Map<Rule, Array<[number, number]>>();
  MARKER_RE.lastIndex = 0;
  for (let m = MARKER_RE.exec(s); m; m = MARKER_RE.exec(s)) {
    const i = m.index;
    // 标记可能互相重叠：下一次从下一个字符接着找
    MARKER_RE.lastIndex = i + 1;
    for (const [mk, rules] of BY_MARKER) {
      if (!s.startsWith(mk, i)) continue;
      for (const r of rules) {
        const list = out.get(r) ?? [];
        list.push([i, mk.length]);
        out.set(r, list);
      }
    }
  }
  return out;
}

/**
 * 规则要跑的窗口（合并过、不重叠）；窗口加起来超过半段时返回 null（整段扫描更快）。
 * 窗口从标记前 back 个字符开始：零宽断言在窗口开头看不到前一个字符，但匹配都从标记附近开始，
 * 只有真正的段首（from = 0）才会落在窗口开头。
 */
function windows(
  s: string,
  r: Rule,
  hits: Array<[number, number]>,
): Array<[number, number]> | null {
  const back = r.back ?? 64;
  const ahead = r.ahead ?? 512;
  const at = hits.map(([i, n]): [number, number] => [
    Math.max(0, i - back),
    Math.min(s.length, i + n + ahead),
  ]);
  if (at.length < 2) return at;
  at.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [at[0]!];
  let total = 0;
  for (let i = 1; i < at.length; i++) {
    const last = out[out.length - 1]!;
    const cur = at[i]!;
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur);
  }
  for (const [a, b] of out) total += b - a;
  return total > s.length / 2 ? null : out;
}

export interface RuleOptions {
  /** 打开严格档（L3） */
  strict?: boolean;
}

/** 按规则找文本里的密钥区间（未合并，可能重叠） */
export function ruleSpans(s: string, opts: RuleOptions = {}): SecretSpan[] {
  const out: SecretSpan[] = [];
  const hits = markerHits(s);
  for (const r of RULES) {
    let ws: Array<[number, number]> | null;
    if (r.strict) {
      if (!opts.strict || !r.markers.some((m) => s.includes(m))) continue;
      ws = null;
    } else {
      const at = hits.get(r);
      if (!at) continue;
      ws = windows(s, r, at);
    }
    if (r.also && !r.also.every((m) => s.includes(m))) continue;
    // 窗口里的匹配换算回整段的下标；窗口相互不重叠，同一个匹配不会记两次
    for (const [from, to] of ws ?? [[0, s.length]]) {
      const text = from === 0 && to === s.length ? s : s.slice(from, to);
      r.re.lastIndex = 0;
      for (const m of text.matchAll(r.re)) {
        const v = r.group ? m[r.group] : m[0];
        if (!v) continue;
        if (r.strict && NOT_CREDENTIAL_NAME.test(m[1] ?? '')) continue;
        if (r.ok && !r.ok(v)) continue;
        const start = from + (r.group ? m.indices![r.group]![0] : m.index);
        out.push({ start, end: start + v.length, kind: r.kind, by: r.strict ? 'strict' : 'rule' });
      }
    }
  }
  if (!out.length) return out;
  const ids = idRanges(s);
  return ids.length ? out.filter((sp) => !ids.some(([a, b]) => sp.start >= a && sp.end <= b)) : out;
}

/**
 * 合并重叠的区间：起点早的优先，同起点长的优先；已知原文与规则同时命中时取先出现、更长的那个。
 */
export function mergeSpans(spans: SecretSpan[]): SecretSpan[] {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretSpan[] = [];
  let end = -1;
  for (const sp of sorted) {
    if (sp.start < end) continue;
    out.push(sp);
    end = sp.end;
  }
  return out;
}

/** 文本里有没有按规则认得出的密钥（情节记忆写入前用） */
export function hasSecret(s: string, opts: RuleOptions = {}): boolean {
  return ruleSpans(s, opts).length > 0;
}
