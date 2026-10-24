/**
 * Nomi 委派编程助手的纯逻辑（docs/design/nomi-delegate-cli.md）：选谁、子任务档位、任务说明、汇报解析。
 * 不依赖 electron，单测直接跑。
 */
import type { HarnessPermissionMode } from '../types';

/** 可以委派的内置编程助手（外部 CLI 暂不支持委派） */
export const DELEGATE_CLIS = ['claude', 'codex', 'grok', 'gemini', 'dsh'] as const;
export type DelegateCli = (typeof DELEGATE_CLIS)[number];

/** 任务类型（设置里按类型配默认编程助手，§4.7） */
export const DELEGATE_KINDS = ['coding', 'prd', 'review', 'research'] as const;
export type DelegateKind = (typeof DELEGATE_KINDS)[number];

export interface DelegateSettings {
  /** 允许 Nomi 委派编程助手 */
  enabled: boolean;
  /** 各任务类型默认交给谁；缺省 = 让 Nomi 选 */
  defaults: Partial<Record<DelegateKind, DelegateCli>>;
}

export const DEFAULT_DELEGATE_SETTINGS: DelegateSettings = { enabled: true, defaults: {} };

export function isDelegateCli(v: unknown): v is DelegateCli {
  return typeof v === 'string' && (DELEGATE_CLIS as readonly string[]).includes(v);
}

export function isDelegateKind(v: unknown): v is DelegateKind {
  return typeof v === 'string' && (DELEGATE_KINDS as readonly string[]).includes(v);
}

export function sanitizeDelegateSettings(raw: unknown): DelegateSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DelegateSettings>;
  const defaults: DelegateSettings['defaults'] = {};
  if (r.defaults && typeof r.defaults === 'object')
    for (const k of DELEGATE_KINDS) {
      const v = (r.defaults as Record<string, unknown>)[k];
      if (isDelegateCli(v)) defaults[k] = v;
    }
  return { enabled: r.enabled !== false, defaults };
}

const ALIASES: Record<string, DelegateCli> = {
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude',
  cc: 'claude',
  codex: 'codex',
  grok: 'grok',
  gemini: 'gemini',
  dsh: 'dsh',
};

/** 用户 / 模型写的名字 → 编程助手 id（不区分大小写，接受别名）；认不出返回 null */
export function resolveDelegateCli(name: unknown): DelegateCli | null {
  if (typeof name !== 'string') return null;
  return ALIASES[name.trim().toLowerCase().replace(/\s+/g, '-')] ?? null;
}

/**
 * 选谁（§4.7）：`/cli` 钉住的 > 用户在消息里点名的（模型据此填的 cli）> 这个任务类型的默认 >
 * 「编程开发」的默认 > 已安装的第一个。都不可用时返回 null。
 */
export function pickDelegateCli(i: {
  pinned?: DelegateCli | null;
  requested?: DelegateCli | null;
  kind: DelegateKind;
  defaults: DelegateSettings['defaults'];
  installed: readonly DelegateCli[];
}): {
  cli: DelegateCli;
  by: 'pinned' | 'requested' | 'kind-default' | 'coding-default' | 'auto';
} | null {
  const ok = (c: DelegateCli | null | undefined): c is DelegateCli =>
    !!c && i.installed.includes(c);
  if (i.pinned) return ok(i.pinned) ? { cli: i.pinned, by: 'pinned' } : null;
  if (ok(i.requested)) return { cli: i.requested, by: 'requested' };
  if (ok(i.defaults[i.kind])) return { cli: i.defaults[i.kind]!, by: 'kind-default' };
  if (ok(i.defaults.coding)) return { cli: i.defaults.coding, by: 'coding-default' };
  const first = DELEGATE_CLIS.find((c) => i.installed.includes(c));
  return first ? { cli: first, by: 'auto' } : null;
}

const MODE_ORDER: HarnessPermissionMode[] = ['plan', 'manual', 'acceptEdits', 'auto', 'bypass'];

/**
 * 子任务标签的档位（§5）：取 Nomi 当前档位与「新标签默认档」中更严的一个；永远不是「完全放开」。
 * Nomi 在「计划」时根本不会派出（PermissionBroker 直接拦下），这里仍按最严处理。
 */
export function childPermissionMode(
  nomi: HarnessPermissionMode,
  tabDefault: HarnessPermissionMode,
): HarnessPermissionMode {
  const a = MODE_ORDER.indexOf(nomi);
  const b = MODE_ORDER.indexOf(tabDefault);
  const m = MODE_ORDER[Math.min(a < 0 ? 0 : a, b < 0 ? 0 : b)]!;
  return m === 'bypass' ? 'auto' : m;
}

export interface DelegateBrief {
  goal: string;
  context?: string;
  doneWhen: string;
  outOfScope?: string;
}

/** 发给编程助手的第一条消息（§4.4）：任务说明 + 固定格式的汇报要求 */
export function buildDelegatePrompt(b: DelegateBrief): string {
  const lines = ['你在帮 Nomi（用户的桌面助手）完成一项任务。', `目标：${b.goal.trim()}`];
  if (b.context?.trim()) lines.push(`背景：${b.context.trim()}`);
  lines.push(`完成标准：${b.doneWhen.trim()}`);
  if (b.outOfScope?.trim()) lines.push(`不要碰：${b.outOfScope.trim()}`);
  lines.push(
    '',
    '做完后，最后一条回复只按下面的格式输出：',
    '<nomi-report>',
    '做了什么：…',
    '改动的文件：每行一个相对路径',
    '没做完的：…（没有就写「无」）',
    '需要用户决定的：…（没有就写「无」）',
    '</nomi-report>',
  );
  return lines.join('\n');
}

export interface DelegateReport {
  done: string;
  changedFiles: string[];
  unfinished?: string;
  needsUser?: string;
}

const REPORT_KEYS: Array<[keyof DelegateReport, RegExp]> = [
  ['done', /^做了什么[:：]/],
  ['changedFiles', /^改动的文件[:：]/],
  ['unfinished', /^没做完的[:：]/],
  ['needsUser', /^需要用户决定的[:：]/],
];

const NONE = /^(无|没有|none|n\/a|-)?[。.]?$/i;

/** 解析最后一个 `<nomi-report>` 块；没有或缺「做了什么」时返回 null */
export function parseDelegateReport(text: string): DelegateReport | null {
  const blocks = [...text.matchAll(/<nomi-report>([\s\S]*?)<\/nomi-report>/g)];
  const body = blocks.at(-1)?.[1];
  if (!body) return null;
  const parts: Partial<Record<keyof DelegateReport, string[]>> = {};
  let cur: keyof DelegateReport | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const hit = REPORT_KEYS.find(([, re]) => re.test(line));
    if (hit) {
      cur = hit[0];
      const rest = line.replace(hit[1], '').trim();
      parts[cur] = rest ? [rest] : [];
    } else if (cur && line) parts[cur]!.push(line);
  }
  // 各项限长：结果整体要能放进界面看到的工具输出（6000 字符）里
  const join = (k: keyof DelegateReport) =>
    (parts[k] ?? [])
      .join('\n')
      .trim()
      .slice(0, k === 'done' ? 1500 : 600);
  const done = join('done');
  if (!done) return null;
  const files = (parts.changedFiles ?? [])
    .map((l) =>
      l
        .replace(/^[-*•]\s*/, '')
        .replace(/^`|`$/g, '')
        .trim(),
    )
    .filter((l) => l && !NONE.test(l))
    .slice(0, 50)
    .map((l) => l.slice(0, 200));
  const opt = (k: 'unfinished' | 'needsUser') => {
    const v = join(k);
    return v && !NONE.test(v) ? { [k]: v } : {};
  };
  return { done, changedFiles: files, ...opt('unfinished'), ...opt('needsUser') };
}

/** `git status --porcelain` 的输出 → 相对路径（重命名取新路径） */
export function parsePorcelain(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.replace(/^"|"$/g, '');
    if (p) files.push(p);
  }
  return files;
}

/** 截断到 max 字符，保留结尾（汇报 / 结论通常在最后） */
export function tailText(text: string, max = 4000): string {
  const s = text.trim();
  return s.length <= max ? s : `…${s.slice(s.length - max)}`;
}
