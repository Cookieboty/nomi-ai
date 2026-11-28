/**
 * 阶段焦点与命令描述辅助（纯函数，无 React）：
 * 1) 识别并隐藏 update_focus 类焦点更新调用，从中提取简短阶段描述；
 * 2) 从命令调用参数/标题中提取人类可读 desc（过滤掉工具名/原命令行回退）；
 * 3) 在 fixedThoughtSummary 模式下把思考中/过程折叠头锁定到当前阶段固定焦点。
 */
import { thoughtTitle } from './timelineShape';

export const COMMAND_KEYS = [
  'command',
  'CommandLine',
  'commandLine',
  'command_line',
  'proposed_command_line',
  'proposedCommandLine',
  'Command',
  'cmd',
  'script',
  'code',
] as const;

export const COMMAND_DESC_KEYS = [
  'toolSummary',
  'tool_summary',
  'toolAction',
  'tool_action',
  'summary',
  'description',
  'Description',
] as const;

export const FOCUS_INPUT_KEYS = ['focus', 'Focus', 'summary', 'description', 'title'] as const;

export const PATH_KEYS = [
  'file_path',
  'path',
  'Path',
  'filePath',
  'FilePath',
  'file',
  'filename',
  'target_file',
  'TargetFile',
  'notebook_path',
  'NotebookPath',
  'notebookPath',
  'directory',
  'Directory',
  'DirectoryPath',
  'directoryPath',
  'SearchPath',
  'searchPath',
  'SearchDirectory',
  'searchDirectory',
  'AbsolutePath',
  'absolutePath',
  'dir',
  'root',
  'from',
  'to',
] as const;

export const PATTERN_KEYS = [
  'pattern',
  'Pattern',
  'query',
  'Query',
  'SearchQuery',
  'search_query',
  'Includes',
  'includes',
  'regex',
  'q',
  'search',
  'glob',
  'text',
  'contains',
  'name',
] as const;

export function extractLineRangeSuffix(o: Record<string, unknown> | null): string {
  if (!o) return '';
  const pickPosInt = (keys: readonly string[]) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
    }
    return undefined;
  };
  const start = pickPosInt(['StartLine', 'startLine', 'start_line']);
  const end = pickPosInt(['EndLine', 'endLine', 'end_line']);
  if (start === undefined) return '';
  if (end !== undefined && end > start) return `#L${start}-${end}`;
  return `#L${start}`;
}

export function extractPrefixedTitlePath(
  title: string | undefined,
  prefix: string,
): string | undefined {
  if (!title) return undefined;
  const trimmed = title.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  const rest = trimmed.slice(prefix.length).trim();
  return rest || undefined;
}

export function extractWebQueryFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const m = /^"(.+)"\s+on\s+Web$/i.exec(title.trim()) ?? /^(.+?)\s+on\s+Web$/i.exec(title.trim());
  return m?.[1]?.trim() || undefined;
}

const GENERIC_COMMAND_TITLES = new Set([
  'bash',
  'terminal',
  'shell',
  'execute',
  'exec',
  'command',
  'run',
  'run_command',
  'run_shell_command',
  'runcommand',
  'runshellcommand',
]);

/** 去掉 MCP / 插件命名空间前缀并统一为小写下划线 */
export function normalizeToolBase(name: string): string {
  const s = name.replace(/^mcp__[^_]+__/, '').replace(/^[a-zA-Z0-9_-]+:/, '');
  return s
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

/** 是否为阶段焦点更新工具（如 Antigravity update_focus） */
export function isFocusToolName(name: string): boolean {
  const norm = normalizeToolBase(name);
  return norm === 'update_focus' || norm === 'updatefocus';
}

export function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function pickFirstString(
  o: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length) {
      const joined = v.join(' ').trim();
      if (joined) return joined;
    }
  }
  return undefined;
}

export function firstLineOf(s: string): string {
  const i = s.indexOf('\n');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

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

function normalizeCmdCompare(s: string): string {
  return firstLineOf(s)
    .replace(/^run\s+/i, '')
    .replace(/^\$\s+/, '')
    .replace(/^`+|`+$/g, '')
    .trim();
}

function looksLikeRunCommandTitle(titleLine: string, cmd: string | undefined): boolean {
  if (!/^run\s+/i.test(titleLine)) return false;
  const rest = titleLine.slice(4).trim();
  if (!rest) return true;
  if (cmd) {
    const cmpCmd = firstLineOf(cmd);
    if (rest === cmpCmd) return true;
    const prefix = cmpCmd.slice(0, Math.min(12, cmpCmd.length));
    if (prefix.length >= 4 && rest.startsWith(prefix)) return true;
  }
  return /[|&;>$`/\\]|\s--?[a-zA-Z0-9]/.test(rest);
}

/** 提取命令的人类可读简述（如 agy 的 toolSummary / description / ACP title），过滤通用工具名或重复命令行 */
export function extractCommandDesc(call: {
  input?: string;
  title?: string;
  name?: string;
}): string | undefined {
  const o = parseJsonObject(call.input);
  const cmd = pickFirstString(o, COMMAND_KEYS) ?? (call.input && !o ? call.input : undefined);
  const paramDesc = pickFirstString(o, COMMAND_DESC_KEYS);
  const fromTitle = !paramDesc ? call.title?.trim() : undefined;
  const raw = paramDesc ?? fromTitle;
  if (!raw) return undefined;
  const line = firstLineOf(raw);
  if (!line) return undefined;
  const normLine = line.toLowerCase().replace(/[-\s]+/g, '_');
  if (GENERIC_COMMAND_TITLES.has(normLine)) return undefined;
  if (call.name && normLine === normalizeToolBase(call.name)) return undefined;
  if (fromTitle && looksLikeRunCommandTitle(line, cmd)) return undefined;
  if (cmd) {
    const cmpCmd = firstLineOf(cmd);
    if (line === cmpCmd || normalizeCmdCompare(line) === cmpCmd) return undefined;
  }
  return line;
}

/** 从 update_focus 调用里提取阶段焦点短语 */
export function extractFocusTextFromCall(call: {
  name: string;
  input?: string;
  title?: string;
}): string | undefined {
  if (!isFocusToolName(call.name)) return undefined;
  const o = parseJsonObject(call.input);
  let raw = pickFirstString(o, FOCUS_INPUT_KEYS);
  if (!raw && !o && call.input?.trim()) raw = call.input.trim();
  if (!raw && call.title?.trim()) {
    const t = call.title.trim();
    if (!isFocusToolName(t)) raw = t;
  }
  if (!raw) return undefined;
  const line = firstLineOf(raw);
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** 计算当前活跃阶段（跳过最后一次插话及前置 update_focus）在 entries 中的起始索引 */
export function activeFocusSliceStart(
  entries: ReadonlyArray<
    | { type: 'interject' }
    | {
        type: 'tool';
        call: { id: string; name: string; input?: string; title?: string; parentId?: string };
      }
    | { type: string }
  >,
): number {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === 'interject') {
      start = i + 1;
      break;
    }
  }
  const subIds = new Set<string>();
  for (const e of entries) {
    if (e.type === 'tool' && 'call' in e) subIds.add(e.call.id);
  }
  let seenFocus = false;
  let seenTool = false;
  let lastFocusText: string | undefined;
  let activeFrom = start;
  for (let i = start; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type !== 'tool' || !('call' in e)) continue;
    const c = e.call;
    if (isFocusToolName(c.name)) {
      const text = extractFocusTextFromCall(c);
      if (!text) continue;
      if (!seenFocus && !seenTool) {
        seenFocus = true;
        lastFocusText = text;
      } else if (text !== lastFocusText) {
        activeFrom = i;
        lastFocusText = text;
        seenTool = false;
      }
      continue;
    }
    if (c.name === 'delegate_to_cli') continue;
    if (c.parentId && subIds.has(c.parentId) && c.id !== c.parentId) continue;
    seenTool = true;
  }
  return activeFrom;
}

/** 按用户中途插话（interject）切分 trace 条目，分段索引与 splitMinimalTurnSections 对齐 */
export function stageSlices<T extends { type: string }>(entries: readonly T[]): T[][] {
  const sections: T[][] = [];
  let cur: T[] = [];
  for (const e of entries) {
    if (e.type === 'interject') {
      sections.push(cur);
      cur = [];
      continue;
    }
    cur.push(e);
  }
  sections.push(cur);
  return sections;
}

/**
 * 解析当前阶段应固定展示的焦点标题：
 * - 优先取该阶段最后一次 update_focus 的文本；
 * - 若未调 update_focus 且 fixedMode 为真，取该阶段首条有效思考的首句。
 */
export function resolveStageFocusTitle(
  entries: ReadonlyArray<
    | { type: 'thinking'; text: string }
    | { type: 'tool'; call: { name: string; input?: string; title?: string } }
    | { type: string }
  >,
  fixedMode: boolean,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'tool' && 'call' in e) {
      const focus = extractFocusTextFromCall(e.call);
      if (focus) return focus;
    }
  }
  if (!fixedMode) return undefined;
  for (const e of entries) {
    if (e.type === 'thinking' && 'text' in e) {
      const first = thoughtTitle(e.text, 'first', 80);
      if (first) return first;
    }
  }
  return undefined;
}
