/**
 * 编程助手会话的「工具轨迹」模型（纯函数，无 React）：
 * 事件流（tool / thinking）→ 工具调用 → 时间线条目（单行 / 分组 / 子代理 / 思考）。
 * 分类、摘要、分组规则都在这里，组件只负责渲染。
 */
import { t } from '@nomi-ai/ui';

import type { HarnessTraceEvent } from '../services/harnessClient';

import { diffAllAdded, diffStrings, parsePatch, type DiffResult } from './lineDiff';

export type ToolKind =
  'read' | 'search' | 'list' | 'edit' | 'write' | 'command' | 'subagent' | 'web' | 'todo' | 'other';

export type CallStatus = 'running' | 'done' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  status: CallStatus;
  input?: string;
  output?: string;
  startedAt?: number;
  endedAt?: number;
  parentId?: string;
}

export type TraceEntry =
  | { type: 'thinking'; id: string; text: string; at?: number; lastAt?: number }
  | { type: 'tool'; call: ToolCall };

/** 分组桶：同桶的连续调用折叠成一组 */
export type Bucket = 'explore' | 'command' | 'edit' | 'other';

export type TimelineItem =
  | {
      type: 'thinking';
      id: string;
      text: string;
      running: boolean;
      /** 思考开始（首个片段到达）与结束（下一步开始 / 整轮结束）；缺数据时不显示秒数 */
      startedAt?: number;
      endedAt?: number;
    }
  | { type: 'call'; call: ToolCall }
  | { type: 'group'; id: string; bucket: Bucket; calls: ToolCall[] }
  | { type: 'subagent'; call: ToolCall; children: TimelineItem[] };

// ───────────────────────── 事件 → 调用 ─────────────────────────

/** 把一串 tool / thinking 事件归并为条目（开始与结果按调用 id 配对，缺 id 时按同名最近一个运行中的） */
export function reduceTrace(events: readonly HarnessTraceEvent[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const byKey = new Map<string, ToolCall>();
  const running: ToolCall[] = [];
  let seq = 0;

  const finish = (c: ToolCall, ev: Extract<HarnessTraceEvent, { type: 'tool' }>) => {
    c.status = ev.status === 'error' ? 'error' : 'done';
    c.endedAt = ev.at ?? c.endedAt;
    if (ev.output !== undefined) c.output = ev.output;
    if (ev.input !== undefined && c.input === undefined) c.input = ev.input;
    if (c.name === 'tool' && ev.name !== 'tool') c.name = ev.name;
    const i = running.indexOf(c);
    if (i >= 0) running.splice(i, 1);
  };

  for (const ev of events) {
    if (ev.type === 'thinking') {
      const last = entries[entries.length - 1];
      if (last?.type === 'thinking') {
        last.text += ev.text;
        if (ev.at !== undefined) last.lastAt = ev.at;
      } else
        entries.push({
          type: 'thinking',
          id: `th-${seq++}`,
          text: ev.text,
          at: ev.at,
          lastAt: ev.at,
        });
      continue;
    }
    const key = ev.id ?? ev.detail;
    if (ev.status === 'start') {
      const existing = key ? byKey.get(key) : undefined;
      if (existing) {
        // 重复的 start（如 Grok 的 tool_call 更新）：补全参数即可
        if (ev.input !== undefined) existing.input = ev.input;
        continue;
      }
      const call: ToolCall = {
        id: key ?? `call-${seq++}`,
        name: ev.name,
        status: 'running',
        input: ev.input,
        startedAt: ev.at,
        parentId: ev.parentId,
      };
      if (key) byKey.set(key, call);
      running.push(call);
      entries.push({ type: 'tool', call });
      continue;
    }
    // done / error
    let target = key ? byKey.get(key) : undefined;
    if (!target) {
      for (let i = running.length - 1; i >= 0; i--) {
        const r = running[i]!;
        if (ev.name === 'tool' || r.name === ev.name) {
          target = r;
          break;
        }
      }
    }
    if (target) finish(target, ev);
    else {
      // 没见过开始事件：直接作为一条已结束的调用
      const call: ToolCall = {
        id: key ?? `call-${seq++}`,
        name: ev.name,
        status: ev.status === 'error' ? 'error' : 'done',
        input: ev.input,
        output: ev.output,
        startedAt: ev.at,
        endedAt: ev.at,
        parentId: ev.parentId,
      };
      if (key) byKey.set(key, call);
      entries.push({ type: 'tool', call });
    }
  }
  return entries;
}

/** 旧消息只存了 `["Read ✓", "Bash ✗", "Grep"]` 这样的字符串：还原成已结束的调用 */
export function entriesFromLegacyTools(tools: readonly string[]): TraceEntry[] {
  return tools.map((label, i) => {
    const m = /^(.*?)\s*([✓✗])?$/u.exec(label.trim());
    const name = m?.[1] || label;
    const mark = m?.[2];
    return {
      type: 'tool' as const,
      call: {
        id: `legacy-${i}`,
        name,
        status: mark === '✗' ? ('error' as const) : ('done' as const),
      },
    };
  });
}

// ───────────────────────── 分类 / 摘要 ─────────────────────────

const KIND_TABLE: Record<ToolKind, readonly string[]> = {
  read: ['read', 'read_file', 'readfile', 'view', 'view_file', 'cat', 'open_file', 'notebookread'],
  search: [
    'grep',
    'glob',
    'search',
    'ripgrep',
    'rg',
    'find',
    'search_files',
    'file_search',
    'codebase_search',
    'grep_search',
    'search_code',
  ],
  list: ['ls', 'list_dir', 'list_directory', 'list_files', 'listdir', 'tree', 'read_dir'],
  edit: [
    'edit',
    'multiedit',
    'multi_edit',
    'str_replace',
    'str_replace_editor',
    'str_replace_based_edit_tool',
    'edit_file',
    'apply_patch',
    'patch',
    'notebookedit',
    'file_change',
    'replace',
    'replace_in_file',
  ],
  write: ['write', 'write_file', 'writefile', 'create_file', 'create'],
  command: [
    'bash',
    'shell',
    'sh',
    'exec',
    'run_command',
    'run_terminal_cmd',
    'terminal',
    'execute',
    'execute_command',
    'powershell',
    'local_shell',
    'bashoutput',
    'killshell',
  ],
  subagent: [
    'task',
    'agent',
    'spawn_subagent',
    'subagent',
    'delegate',
    'spawn_agent',
    'dispatch_agent',
  ],
  web: ['websearch', 'web_search', 'webfetch', 'web_fetch', 'fetch', 'fetch_url', 'browser'],
  todo: ['todowrite', 'todo_write', 'todo', 'update_plan', 'plan', 'exitplanmode'],
  other: [],
};

const KIND_BY_NAME = new Map<string, ToolKind>();
for (const [kind, names] of Object.entries(KIND_TABLE) as Array<[ToolKind, readonly string[]]>)
  for (const n of names) KIND_BY_NAME.set(n, kind);

/** `mcp__server__tool` / `server.tool` → 取最后一段；统一小写 */
export function baseToolName(name: string): string {
  const parts = name.split(/__|\./).filter(Boolean);
  return (parts[parts.length - 1] ?? name).toLowerCase();
}

export function classifyTool(name: string): ToolKind {
  const lower = name.toLowerCase();
  return KIND_BY_NAME.get(lower) ?? KIND_BY_NAME.get(baseToolName(name)) ?? 'other';
}

export function bucketOf(kind: ToolKind): Bucket {
  switch (kind) {
    case 'read':
    case 'search':
    case 'list':
    case 'web':
      return 'explore';
    case 'command':
      return 'command';
    case 'edit':
    case 'write':
      return 'edit';
    default:
      return 'other';
  }
}

export function parseInput(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const v = JSON.parse(input) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const firstString = (
  o: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined => {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length) return v.join(' ');
  }
  return undefined;
};

const PATH_KEYS = [
  'file_path',
  'path',
  'filePath',
  'file',
  'filename',
  'target_file',
  'notebook_path',
  'directory',
  'dir',
] as const;
const PATTERN_KEYS = ['pattern', 'query', 'regex', 'q', 'search', 'glob', 'text'] as const;
const COMMAND_KEYS = ['command', 'cmd', 'script'] as const;

/** 过长路径只保留末尾几段 */
export function shortPath(p: string, max = 56): string {
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/).filter(Boolean);
  let out = parts[parts.length - 1] ?? p;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  return `…/${out}`;
}

export interface CallDescription {
  kind: ToolKind;
  /** 动作（已翻译）：读取 / 搜索 / 运行命令 … */
  verb: string;
  /** 对象：路径 / 模式 / 命令 / 工具名；等宽显示 */
  target?: string;
}

export function describeCall(call: ToolCall): CallDescription {
  const kind = classifyTool(call.name);
  const o = parseInput(call.input);
  const path = firstString(o, PATH_KEYS);
  const pattern = firstString(o, PATTERN_KEYS);
  const trimTarget = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (kind) {
    case 'read':
      return { kind, verb: t('读取'), target: path ? shortPath(path) : undefined };
    case 'search':
      return {
        kind,
        verb: t('搜索'),
        target: pattern ? trimTarget(pattern, 80) : path ? shortPath(path) : undefined,
      };
    case 'list':
      return { kind, verb: t('列出'), target: path ? shortPath(path) : undefined };
    case 'edit':
      return { kind, verb: t('编辑'), target: path ? shortPath(path) : changePath(o) };
    case 'write':
      return { kind, verb: t('写入'), target: path ? shortPath(path) : undefined };
    case 'command': {
      const cmd = firstString(o, COMMAND_KEYS) ?? (call.input && !o ? call.input : undefined);
      return { kind, verb: t('运行命令'), target: cmd ? trimTarget(firstLine(cmd)) : undefined };
    }
    case 'subagent': {
      const d = firstString(o, ['description', 'prompt', 'task', 'message']);
      return { kind, verb: t('子代理'), target: d ? trimTarget(firstLine(d), 100) : undefined };
    }
    case 'web': {
      const url = firstString(o, ['url']);
      return url
        ? { kind, verb: t('访问'), target: trimTarget(url, 100) }
        : { kind, verb: t('搜索网页'), target: pattern ? trimTarget(pattern, 80) : undefined };
    }
    case 'todo':
      return { kind, verb: t('更新任务清单') };
    default: {
      const hint = path ?? pattern ?? firstString(o, COMMAND_KEYS);
      return {
        kind,
        verb: t('调用'),
        target: hint ? `${call.name} · ${trimTarget(firstLine(hint), 60)}` : call.name,
      };
    }
  }
}

const firstLine = (s: string): string => s.split('\n', 1)[0] ?? s;

function changePath(o: Record<string, unknown> | null): string | undefined {
  const ch = o?.changes;
  if (Array.isArray(ch) && ch.length) {
    const first = (ch[0] as { path?: unknown }).path;
    const name = typeof first === 'string' ? shortPath(first) : undefined;
    return name && ch.length > 1 ? `${name} +${ch.length - 1}` : name;
  }
  return undefined;
}

// ───────────────────────── 命令 / diff ─────────────────────────

export function commandOf(call: ToolCall): string | undefined {
  const o = parseInput(call.input);
  return firstString(o, COMMAND_KEYS) ?? (!o && call.input ? call.input : undefined);
}

export interface FileDiff {
  file: string;
  /** 变更类型（来自 codex file_change） */
  changeKind?: string;
  diff: DiffResult;
  /** 没有可展示的行内容（只知道改了哪些文件） */
  summaryOnly?: boolean;
}

const DIFF_CACHE_MAX = 200;
const diffCache = new Map<string, FileDiff[]>();

/** 编辑 / 写入类调用 → 每个文件一份 diff；识别不了返回空数组（按名称 + 参数缓存，避免每次渲染重算 LCS） */
export function diffsOf(call: ToolCall): FileDiff[] {
  const key = `${call.name}\u0000${call.input ?? ''}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  const out = computeDiffs(call);
  if (diffCache.size >= DIFF_CACHE_MAX) diffCache.delete(diffCache.keys().next().value as string);
  diffCache.set(key, out);
  return out;
}

function computeDiffs(call: ToolCall): FileDiff[] {
  const kind = classifyTool(call.name);
  if (kind !== 'edit' && kind !== 'write') return [];
  const o = parseInput(call.input);
  const rawPatch = !o && call.input ? call.input : undefined;
  if (rawPatch) {
    const diff = parsePatch(rawPatch);
    const file = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(rawPatch)?.[1] ?? t('补丁');
    return diff.lines.length ? [{ file, diff }] : [];
  }
  if (!o) return [];
  const file = firstString(o, PATH_KEYS) ?? '';

  const changes = o.changes;
  if (Array.isArray(changes) && changes.length) {
    return changes.map((c) => {
      const row = (c ?? {}) as { path?: unknown; kind?: unknown; diff?: unknown };
      const diff =
        typeof row.diff === 'string' ? parsePatch(row.diff) : { lines: [], added: 0, removed: 0 };
      return {
        file: typeof row.path === 'string' ? row.path : '',
        changeKind: typeof row.kind === 'string' ? row.kind : undefined,
        diff,
        summaryOnly: diff.lines.length === 0,
      };
    });
  }

  const patch = firstString(o, ['patch', 'diff', 'unified_diff']);
  if (patch) return [{ file, diff: parsePatch(patch) }];

  const edits = Array.isArray(o.edits) ? (o.edits as Array<Record<string, unknown>>) : null;
  const pairs = edits ?? [o];
  const results: DiffResult[] = [];
  for (const e of pairs) {
    const oldS = firstString(e, ['old_string', 'old_str', 'oldText', 'old_text', 'old', 'search']);
    const newS =
      typeof e.new_string === 'string'
        ? e.new_string
        : typeof e.new_str === 'string'
          ? e.new_str
          : typeof e.newText === 'string'
            ? e.newText
            : typeof e.new_text === 'string'
              ? e.new_text
              : typeof e.replace === 'string'
                ? e.replace
                : undefined;
    if (newS === undefined) continue;
    results.push(diffStrings(oldS ?? '', newS));
  }
  if (results.length) {
    const merged: DiffResult = { lines: [], added: 0, removed: 0 };
    results.forEach((r, i) => {
      if (i > 0) merged.lines.push({ type: 'hunk', text: '…' });
      merged.lines.push(...r.lines);
      merged.added += r.added;
      merged.removed += r.removed;
    });
    return [{ file, diff: merged }];
  }
  const content = typeof o.content === 'string' ? o.content : undefined;
  if (content !== undefined && kind === 'write') return [{ file, diff: diffAllAdded(content) }];
  return [];
}

export function diffStats(
  call: ToolCall,
): { added: number; removed: number; files: number } | null {
  const d = diffsOf(call);
  if (!d.length) return null;
  return {
    added: d.reduce((n, x) => n + x.diff.added, 0),
    removed: d.reduce((n, x) => n + x.diff.removed, 0),
    files: d.length,
  };
}

// ───────────────────────── 时间线 / 分组 ─────────────────────────

/**
 * 条目 → 时间线：
 * - 带 parentId 的调用归入对应子代理；
 * - 子代理独立成块；
 * - 连续同桶（探索 / 命令 / 编辑 / 其它）的 2 个及以上调用折叠成一组，单个调用保持单行；
 * - `live` 为 true 时，最后一条思考视为进行中。
 */
export function buildTimeline(
  entries: readonly TraceEntry[],
  live = false,
  /** 整轮结束时间（已结束的消息传入）：最后一段思考据此算出耗时 */
  endAt?: number,
): TimelineItem[] {
  const subagents = new Map<string, ToolCall>();
  for (const e of entries)
    if (e.type === 'tool' && classifyTool(e.call.name) === 'subagent')
      subagents.set(e.call.id, e.call);

  const childrenOf = new Map<string, TraceEntry[]>();
  const top: TraceEntry[] = [];
  for (const e of entries) {
    const pid = e.type === 'tool' ? e.call.parentId : undefined;
    if (pid && subagents.has(pid) && pid !== (e.type === 'tool' ? e.call.id : '')) {
      const list = childrenOf.get(pid) ?? [];
      list.push(e);
      childrenOf.set(pid, list);
    } else top.push(e);
  }

  const build = (list: readonly TraceEntry[], isLive: boolean): TimelineItem[] => {
    const items: TimelineItem[] = [];
    let run: ToolCall[] = [];
    let runBucket: Bucket | null = null;
    const flush = () => {
      if (run.length === 1) items.push({ type: 'call', call: run[0]! });
      else if (run.length > 1)
        items.push({ type: 'group', id: `g-${run[0]!.id}`, bucket: runBucket!, calls: run });
      run = [];
      runBucket = null;
    };
    list.forEach((e, idx) => {
      if (e.type === 'thinking') {
        flush();
        const next = list[idx + 1];
        const nextAt = next ? (next.type === 'tool' ? next.call.startedAt : next.at) : undefined;
        const running = isLive && idx === list.length - 1;
        items.push({
          type: 'thinking',
          id: e.id,
          text: e.text,
          running,
          startedAt: e.at,
          endedAt: running ? undefined : (nextAt ?? (next ? e.lastAt : (endAt ?? e.lastAt))),
        });
        return;
      }
      const kind = classifyTool(e.call.name);
      if (kind === 'subagent') {
        flush();
        items.push({
          type: 'subagent',
          call: e.call,
          children: build(childrenOf.get(e.call.id) ?? [], isLive && e.call.status === 'running'),
        });
        return;
      }
      const b = bucketOf(kind);
      if (runBucket !== null && runBucket !== b) flush();
      runBucket = b;
      run.push(e.call);
    });
    flush();
    return items;
  };
  return build(top, live);
}

// ───────────────────────── 分组摘要 ─────────────────────────

export interface GroupStats {
  files: number;
  searches: number;
  lists: number;
  webs: number;
  commands: number;
  edits: number;
  others: number;
  failed: number;
  running: number;
  added: number;
  removed: number;
}

export function groupStats(calls: readonly ToolCall[]): GroupStats {
  const s: GroupStats = {
    files: 0,
    searches: 0,
    lists: 0,
    webs: 0,
    commands: 0,
    edits: 0,
    others: 0,
    failed: 0,
    running: 0,
    added: 0,
    removed: 0,
  };
  const editedFiles = new Set<string>();
  for (const c of calls) {
    if (c.status === 'error') s.failed++;
    if (c.status === 'running') s.running++;
    switch (classifyTool(c.name)) {
      case 'read':
        s.files++;
        break;
      case 'search':
        s.searches++;
        break;
      case 'list':
        s.lists++;
        break;
      case 'web':
        s.webs++;
        break;
      case 'command':
        s.commands++;
        break;
      case 'edit':
      case 'write': {
        const d = diffsOf(c);
        if (d.length) {
          for (const f of d) editedFiles.add(f.file || c.id);
          s.added += d.reduce((n, x) => n + x.diff.added, 0);
          s.removed += d.reduce((n, x) => n + x.diff.removed, 0);
        } else editedFiles.add(c.id);
        break;
      }
      default:
        s.others++;
    }
  }
  s.edits = editedFiles.size;
  return s;
}

/** 分组标题：「已探索 3 个文件、5 次搜索」「正在运行 2 条命令」「已编辑 3 个文件」「调用了 4 个工具」 */
export function groupTitle(bucket: Bucket, calls: readonly ToolCall[]): string {
  const s = groupStats(calls);
  const running = s.running > 0;
  if (bucket === 'explore') {
    const parts: string[] = [];
    if (s.files) parts.push(t('{0} 个文件', s.files));
    if (s.searches) parts.push(t('{0} 次搜索', s.searches));
    if (s.lists) parts.push(t('{0} 个目录', s.lists));
    if (s.webs) parts.push(t('{0} 次联网', s.webs));
    const body = parts.join(t('、'));
    return running ? t('正在探索 {0}', body) : t('已探索 {0}', body);
  }
  if (bucket === 'command')
    return running ? t('正在运行 {0} 条命令', s.commands) : t('已运行 {0} 条命令', s.commands);
  if (bucket === 'edit')
    return running ? t('正在编辑 {0} 个文件', s.edits) : t('已编辑 {0} 个文件', s.edits);
  return running ? t('正在调用 {0} 个工具', calls.length) : t('已调用 {0} 个工具', calls.length);
}

// ───────────────────────── 耗时 ─────────────────────────

export function callDuration(c: Pick<ToolCall, 'startedAt' | 'endedAt'>): number | undefined {
  if (c.startedAt === undefined || c.endedAt === undefined) return undefined;
  const d = c.endedAt - c.startedAt;
  return d >= 0 ? d : undefined;
}

export function groupDuration(calls: readonly ToolCall[]): number | undefined {
  const starts = calls.map((c) => c.startedAt).filter((x): x is number => x !== undefined);
  const ends = calls.map((c) => c.endedAt).filter((x): x is number => x !== undefined);
  if (!starts.length || !ends.length || calls.some((c) => c.status === 'running')) return undefined;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** 整个时间线里是否还有运行中的调用 */
export function hasRunning(items: readonly TimelineItem[]): boolean {
  return items.some((it) => {
    if (it.type === 'call') return it.call.status === 'running';
    if (it.type === 'group') return it.calls.some((c) => c.status === 'running');
    if (it.type === 'subagent') return it.call.status === 'running' || hasRunning(it.children);
    return it.running;
  });
}
