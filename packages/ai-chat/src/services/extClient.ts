import { t } from '@nomi-ai/ui';
/** 扩展客户端：MCP 服务器 + 技能包（`ai:ext:*` IPC） */
export type Transport = 'stdio' | 'http' | 'sse';
export type Trust = 'ask' | 'read-auto' | 'auto';
export type McpStatus = 'off' | 'connecting' | 'connected' | 'error';

export interface McpTool {
  name: string;
  description: string;
  readOnly: boolean;
  dangerous: boolean;
}
export interface McpServer {
  id: string;
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  trust: Trust;
  origin: 'user' | 'env';
  status: McpStatus;
  error?: string;
  tools: McpTool[];
}
export interface McpPreset {
  key: string;
  name: string;
  description: string;
  server: Partial<McpServer>;
  needs?: string;
  license: string;
}
export interface McpList {
  servers: McpServer[];
  env: Array<Pick<McpServer, 'id' | 'name' | 'origin' | 'status' | 'tools'>>;
  presets: McpPreset[];
  ready: boolean;
}
export interface SkillInfo {
  name: string;
  description: string;
  version?: string;
  license?: string;
  author?: string;
  enabled: boolean;
  builtin: boolean;
  files: string[];
  error?: string;
  dir: string;
}
export interface SkillDoc {
  meta: { name: string; description: string; version?: string; license?: string; author?: string };
  body: string;
  files: string[];
}

export type MigrateTool = 'claude' | 'codex';
export type MigrateScope = 'user' | 'local' | 'project';
export type MigrateAction = 'skip' | 'rename' | 'overwrite';
interface MigrateBase {
  key: string;
  tool: MigrateTool;
  scope: MigrateScope;
  name: string;
  where: string;
  warnings: string[];
  error?: string;
  /** Nomi 里已有同名项 */
  conflict: boolean;
}
export interface MigrateMcpItem extends MigrateBase {
  kind: 'mcp';
  preview?: {
    transport: Transport;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
}
export interface MigrateSkillItem extends MigrateBase {
  kind: 'skill';
  preview: { description: string; files: string[]; bytes: number };
}
export interface MigrateScanResult {
  project: string | null;
  sources: Array<{ tool: MigrateTool; where: string; found: boolean; error?: string }>;
  mcp: MigrateMcpItem[];
  skills: MigrateSkillItem[];
}
export interface MigrateImportResult {
  imported: Array<{ key: string; kind: 'mcp' | 'skill'; name: string }>;
  skipped: Array<{ key: string; name: string }>;
  failed: Array<{ key: string; name: string; error: string }>;
}
export const TOOL_LABEL: Record<MigrateTool, string> = { claude: 'Claude Code', codex: 'Codex' };
export const SCOPE_LABEL: Record<MigrateScope, string> = {
  user: '用户级',
  local: '本机项目级',
  project: '项目',
};

export const TRUST_LABEL: Record<Trust, string> = {
  ask: '每次确认',
  'read-auto': '只读自动，其它确认',
  auto: '全部自动（仍记录）',
};
export const STATUS_LABEL: Record<McpStatus, string> = {
  off: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  error: '连接失败',
};

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}
const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('扩展功能需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:ext:${method}`, ...args)) as T & {
    __error?: { code: string; message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const extClient = {
  available: () => !!bridge(),
  mcpList: () => call<McpList>('mcp-list'),
  mcpUpsert: (s: Partial<McpServer>) => call<McpServer>('mcp-upsert', s),
  mcpRemove: (id: string) => call<boolean>('mcp-remove', id),
  mcpToggle: (id: string, v: boolean) => call<boolean>('mcp-toggle', id, v),
  mcpConnect: (id: string) => call('mcp-connect', id),
  mcpDisconnect: (id: string) => call('mcp-disconnect', id),
  mcpImport: (text: string) => call<McpServer[]>('mcp-import', text),
  skills: () => call<SkillInfo[]>('skills-list'),
  skillGet: (n: string) => call<SkillDoc>('skill-get', n),
  skillSave: (p: { meta: SkillDoc['meta']; body: string; originalName?: string }) =>
    call('skill-save', p),
  skillRemove: (n: string) => call<boolean>('skill-remove', n),
  skillToggle: (n: string, v: boolean) => call<boolean>('skill-toggle', n, v),
  skillImport: () => call<SkillDoc['meta'] | null>('skill-import'),
  skillOpen: (n?: string) => call('skill-open', n),
  /** 从 Claude Code / Codex 扫描可导入的 MCP 与技能（#58）；pickProject 时主进程弹出选择文件夹 */
  migrateScan: (o: { pickProject?: boolean; clearProject?: boolean } = {}) =>
    call<MigrateScanResult>('migrate-scan', o),
  migrateImport: (items: Array<{ key: string; action?: MigrateAction }>) =>
    call<MigrateImportResult>('migrate-import', items),
  /** 注入对话 system 的技能目录（失败时为空串） */
  context: async (): Promise<string> => {
    if (!bridge()) return '';
    try {
      return (await call<string>('skills-context')) || '';
    } catch {
      return '';
    }
  },
  onChanged: (fn: () => void) => bridge()?.on('ai:ext:changed', () => fn()) ?? (() => undefined),
};

/** 「KEY=VALUE」多行文本 ↔ 对象 */
export function parseKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}
export const kvText = (m?: Record<string, string>) =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

/** 参数输入：按空格分隔，支持引号 */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
export const joinArgs = (a?: string[]) =>
  (a ?? []).map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
