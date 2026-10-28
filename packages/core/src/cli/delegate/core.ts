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

/** 委派时覆盖子 CLI 模型 / 思考深度的档位（A1：单层委派，不做 planner/executor） */
export interface AgentProfile {
  id: string;
  label: string;
  /** provider/model 或 CLI 原生模型 id；缺省 = 不覆盖 */
  model?: string;
  reasoningEffort?: string | null;
  /** 元数据占位：后续 B2 工具白名单；本阶段仅透传 */
  preferLocal?: boolean;
}

/** 内置档位：default 不覆盖；cheap 可从 settings.cheapModel 解析；local 仅标记 preferLocal */
export const BUILTIN_AGENT_PROFILES: readonly AgentProfile[] = [
  { id: 'default', label: '默认（沿用 CLI）' },
  { id: 'cheap', label: '便宜模型' },
  { id: 'local', label: '本地优先', preferLocal: true },
];

export interface DelegateSettings {
  /** 允许 Nomi 委派编程助手 */
  enabled: boolean;
  /** 各任务类型默认交给谁；缺省 = 让 Nomi 选 */
  defaults: Partial<Record<DelegateKind, DelegateCli>>;
  /** 默认委派档位 id（builtin 或用户自定义） */
  defaultProfileId?: string;
  /** 用户自定义 / 覆盖内置的档位（按 id 合并） */
  profiles?: AgentProfile[];
  /** cheap 档位未自带 model 时使用的模型 id */
  cheapModel?: string;
}

export const DEFAULT_DELEGATE_SETTINGS: DelegateSettings = {
  enabled: true,
  defaults: {},
  defaultProfileId: 'default',
};

export function isDelegateCli(v: unknown): v is DelegateCli {
  return typeof v === 'string' && (DELEGATE_CLIS as readonly string[]).includes(v);
}

export function isDelegateKind(v: unknown): v is DelegateKind {
  return typeof v === 'string' && (DELEGATE_KINDS as readonly string[]).includes(v);
}

function sanitizeProfile(raw: unknown): AgentProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim().slice(0, 64) : '';
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return null;
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : id;
  const model =
    typeof r.model === 'string' && r.model.trim() ? r.model.trim().slice(0, 128) : undefined;
  const effortRaw = r.reasoningEffort;
  const reasoningEffort =
    effortRaw === null
      ? null
      : typeof effortRaw === 'string' && effortRaw.trim()
        ? effortRaw.trim().slice(0, 32)
        : undefined;
  const preferLocal = r.preferLocal === true ? true : undefined;
  return {
    id,
    label,
    ...(model ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(preferLocal ? { preferLocal } : {}),
  };
}

/** 内置 + 用户档位按 id 合并（用户可覆盖 label/model） */
export function mergeAgentProfiles(user?: readonly AgentProfile[]): AgentProfile[] {
  const map = new Map<string, AgentProfile>();
  for (const p of BUILTIN_AGENT_PROFILES) map.set(p.id, { ...p });
  for (const raw of user ?? []) {
    const p = sanitizeProfile(raw);
    if (!p) continue;
    const prev = map.get(p.id);
    map.set(p.id, {
      id: p.id,
      label: p.label || prev?.label || p.id,
      ...(p.model !== undefined ? { model: p.model } : prev?.model ? { model: prev.model } : {}),
      ...(p.reasoningEffort !== undefined
        ? { reasoningEffort: p.reasoningEffort }
        : prev && 'reasoningEffort' in prev
          ? { reasoningEffort: prev.reasoningEffort }
          : {}),
      ...(p.preferLocal || prev?.preferLocal ? { preferLocal: true } : {}),
    });
  }
  return [...map.values()];
}

export function sanitizeDelegateSettings(raw: unknown): DelegateSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DelegateSettings>;
  const defaults: DelegateSettings['defaults'] = {};
  if (r.defaults && typeof r.defaults === 'object')
    for (const k of DELEGATE_KINDS) {
      const v = (r.defaults as Record<string, unknown>)[k];
      if (isDelegateCli(v)) defaults[k] = v;
    }
  const profiles = Array.isArray(r.profiles)
    ? (r.profiles.map(sanitizeProfile).filter(Boolean) as AgentProfile[])
    : undefined;
  const merged = mergeAgentProfiles(profiles);
  const defaultProfileId =
    typeof r.defaultProfileId === 'string' && r.defaultProfileId.trim()
      ? r.defaultProfileId.trim().slice(0, 64)
      : 'default';
  const cheapModel =
    typeof r.cheapModel === 'string' && r.cheapModel.trim()
      ? r.cheapModel.trim().slice(0, 128)
      : undefined;
  return {
    enabled: r.enabled !== false,
    defaults,
    defaultProfileId: merged.some((p) => p.id === defaultProfileId) ? defaultProfileId : 'default',
    ...(profiles && profiles.length ? { profiles } : {}),
    ...(cheapModel ? { cheapModel } : {}),
  };
}

export type ResolveDelegateOverridesOk = {
  ok: true;
  profileId: string;
  model?: string;
  reasoningEffort?: string | null;
  preferLocal?: boolean;
};
export type ResolveDelegateOverridesErr = {
  ok: false;
  code: 'unknown_profile';
  message: string;
};

/**
 * 解析委派模型覆盖：显式 model > profile.model >（cheap 时 settings.cheapModel）> 默认档位 > 不覆盖（CLI 默认）。
 * reasoning_effort：显式 > profile.reasoningEffort。
 */
export function resolveDelegateOverrides(input: {
  model?: string | null;
  reasoningEffort?: string | null;
  profile?: string | null;
  settings: DelegateSettings;
}): ResolveDelegateOverridesOk | ResolveDelegateOverridesErr {
  const profiles = mergeAgentProfiles(input.settings.profiles);
  const requested =
    (typeof input.profile === 'string' && input.profile.trim()) ||
    input.settings.defaultProfileId ||
    'default';
  const profile = profiles.find((p) => p.id === requested);
  if (!profile)
    return {
      ok: false,
      code: 'unknown_profile',
      message: `未知的委派模型档位：${requested}`,
    };

  const explicitModel = typeof input.model === 'string' ? input.model.trim() : '';
  let model: string | undefined;
  if (explicitModel) model = explicitModel.slice(0, 128);
  else if (profile.model?.trim()) model = profile.model.trim();
  else if (profile.id === 'cheap' && input.settings.cheapModel?.trim())
    model = input.settings.cheapModel.trim();

  let reasoningEffort: string | null | undefined;
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== null) {
    const e = String(input.reasoningEffort).trim();
    reasoningEffort = e ? e.slice(0, 32) : null;
  } else if (profile.reasoningEffort !== undefined) {
    reasoningEffort = profile.reasoningEffort;
  }

  return {
    ok: true,
    profileId: profile.id,
    ...(model ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(profile.preferLocal ? { preferLocal: true } : {}),
  };
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
    '做完后，最后一条回复只按下面的格式输出（标记原样保留）：',
    '[nomi-report]',
    '做了什么：…',
    '改动的文件：每行一个相对路径',
    '没做完的：…（没有就写「无」）',
    '需要用户决定的：…（没有就写「无」）',
    '[/nomi-report]',
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

/**
 * 解析最后一个 `[nomi-report]` 块；没有或缺「做了什么」时返回 null。
 * 用方括号而不用 `<nomi-report>`：对话界面的 Markdown 不渲染 HTML，尖括号标记会让整段汇报在标签里看不见。
 */
export function parseDelegateReport(text: string): DelegateReport | null {
  const blocks = [...text.matchAll(/\[nomi-report\]([\s\S]*?)\[\/nomi-report\]/g)];
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

/**
 * `git status --porcelain` / `--porcelain -z` → 相对路径（重命名取新路径）。
 * `-z`：条目用 NUL 分隔；普通为 `XY path\0`；重命名为 `XY new\0old\0`（先新后旧，与非 -z 的 `old -> new` 相反）。
 * 换行格式：`XY path` 或 `XY old -> new`。
 */
export function parsePorcelain(out: string): string[] {
  if (!out) return [];
  if (out.includes('\0')) {
    const files: string[] = [];
    const parts = out.split('\0').filter((s) => s.length > 0);
    for (let i = 0; i < parts.length; i++) {
      const ent = parts[i]!;
      if (ent.length < 3) continue;
      const xy = ent.slice(0, 2);
      // 标准 porcelain：XY + 空格 + path（重命名时本段已是新路径）
      let file = ent.slice(3);
      if ((xy[0] === 'R' || xy[0] === 'C') && i + 1 < parts.length) i += 1; // 跳过旧路径
      file = file.replace(/^"|"$/g, '');
      if (file) files.push(file);
    }
    return files;
  }
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
