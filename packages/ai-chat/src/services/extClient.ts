import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import { plainError } from './hostBackends/knowledge';
/** 扩展客户端：MCP 服务器 + 技能包——契约 `ext.*`（docs/design/core-host-decoupling.md §12 P1b，原 `ai:ext:*`） */
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
  user: 'ui.foundation.user',
  local: 'ui.foundation.local-project',
  project: 'ui.slash-commands.project',
};

export const TRUST_LABEL: Record<Trust, string> = {
  ask: 'ui.chat-settings.confirm-every-time',
  'read-auto': 'ui.chat-settings.auto-for-read-only-confirm-others',
  auto: 'ui.chat-settings.all-automatic-still-logged',
};
export const STATUS_LABEL: Record<McpStatus, string> = {
  off: 'ui.chat-settings.not-connected',
  connecting: 'ui.foundation.connecting',
  connected: 'ui.chat-settings.connected',
  error: 'ui.chat-settings.connection-failed',
};

async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport()) throw new Error(t('ui.chat-settings.extensions-require-the-desktop-app'));
  try {
    return (await run()) as T;
  } catch (err) {
    throw plainError(err);
  }
}

export const extClient = {
  available: () => hasTransport(),
  mcpList: () => call<McpList>(() => api.ext.mcpList()),
  mcpUpsert: (s: Partial<McpServer>) => call<McpServer>(() => api.ext.mcpUpsert(s)),
  mcpRemove: (id: string) => call<boolean>(() => api.ext.mcpRemove({ id })),
  mcpToggle: (id: string, v: boolean) => call<boolean>(() => api.ext.mcpToggle({ id, enabled: v })),
  mcpConnect: (id: string) => call(() => api.ext.mcpConnect({ id })),
  mcpDisconnect: (id: string) => call(() => api.ext.mcpDisconnect({ id })),
  mcpImport: (text: string) => call<McpServer[]>(() => api.ext.mcpImport({ text })),
  skills: () => call<SkillInfo[]>(() => api.ext.skillsList()),
  skillGet: (n: string) => call<SkillDoc>(() => api.ext.skillGet({ name: n })),
  skillSave: (p: { meta: SkillDoc['meta']; body: string; originalName?: string }) =>
    call(() => api.ext.skillSave(p)),
  skillRemove: (n: string) => call<boolean>(() => api.ext.skillRemove({ name: n })),
  skillToggle: (n: string, v: boolean) =>
    call<boolean>(() => api.ext.skillToggle({ name: n, enabled: v })),
  skillImport: () => call<SkillDoc['meta'] | null>(() => api.ext.skillImport()),
  skillOpen: (n?: string) => call(() => api.ext.skillOpen({ name: n })),
  /** 从 Claude Code / Codex 扫描可导入的 MCP 与技能（#58）；pickProject 时主进程弹出选择文件夹 */
  migrateScan: (o: { pickProject?: boolean; clearProject?: boolean } = {}) =>
    call<MigrateScanResult>(() => api.ext.migrateScan(o)),
  migrateImport: (items: Array<{ key: string; action?: MigrateAction }>) =>
    call<MigrateImportResult>(() => api.ext.migrateImport({ items })),
  /** 注入对话 system 的技能目录（失败时为空串） */
  context: async (): Promise<string> => {
    if (!hasTransport()) return '';
    try {
      return (await call<string>(() => api.ext.skillsContext())) || '';
    } catch {
      return '';
    }
  },
  onChanged: (fn: () => void) =>
    hasTransport() ? api.on('ext.changed', () => fn()) : () => undefined,
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
