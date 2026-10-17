import { t } from '@nomi-ai/ui';
/** 编程助手进度客户端：`ai:agents:*` IPC（经 preload 的 window.aiIPC） */
export type AgentKind =
  'codex' | 'claude' | 'dsh' | 'grok' | 'aider' | 'cline' | 'continue' | 'cursor' | 'gemini';
export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stalled' | 'idle';

export interface AgentWatchSettings {
  enabled: boolean;
  stallMs: number;
  cooldownMs: number;
  osNotify: boolean;
  /** 总结播报：定时汇总附带进度、任务结束播报完成总结（默认关） */
  summaryEnabled: boolean;
  tools: Record<AgentKind, boolean>;
}

/** 会话累计用量（costUsd 为 null = 全部来自未定价模型） */
export interface SessionUsageView {
  tokens: number;
  costUsd: number | null;
  calls: number;
  unpriced: boolean;
}

export interface AgentSessionView {
  id: string;
  kind: AgentKind | 'nomi';
  /** file = 本机会话文件；tab = Nomi 对话标签 */
  source?: 'file' | 'tab';
  tabId?: string;
  unread?: number;
  label: string;
  project?: string;
  cwd?: string;
  title: string;
  status: AgentStatus;
  summary?: string;
  alive?: boolean;
  path: string;
  mtime: number;
  updatedAt: number;
  /** 这个会话累计的 Token / 费用（用量统计开着、且能对上会话时才有） */
  usage?: SessionUsageView;
}

export interface AgentWatchState {
  settings: AgentWatchSettings;
  sessions: AgentSessionView[];
  detected: AgentKind[];
  lastRemindAt: number;
}

export const AGENT_LABEL: Record<AgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  dsh: 'dsh',
  grok: 'Grok',
  aider: 'Aider',
  cline: 'Cline',
  continue: 'Continue',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  stalled: '可能卡住',
  waiting: '等你回复',
  idle: '已结束',
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
  if (!b) throw new Error(t('编程助手监视需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:agents:${method}`, ...args)) as T & {
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}
const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

export const agentsClient = {
  available: () => !!bridge(),
  state: () => call<AgentWatchState>('state'),
  setSettings: (
    p: Omit<Partial<AgentWatchSettings>, 'tools'> & {
      tools?: Partial<Record<AgentKind, boolean>>;
    },
  ) => call<AgentWatchSettings>('set-settings', p),
  scan: () => call<AgentWatchState>('scan'),
  onChanged: (fn: () => void) => on('ai:agents:changed', () => fn()),
};

/** 监视视图按端点过滤：全部 / 各 CLI / Nomi 标签 */
export type EndpointFilter = 'all' | 'tabs' | AgentKind;

export function filterSessions(list: AgentSessionView[], f: EndpointFilter): AgentSessionView[] {
  if (f === 'all') return list;
  if (f === 'tabs') return list.filter((s) => s.source === 'tab');
  return list.filter((s) => s.kind === f);
}

/** 各端点的会话数（只列出现过的端点） */
export function endpointCounts(list: AgentSessionView[]): Array<[EndpointFilter, number]> {
  const out = new Map<EndpointFilter, number>([['all', list.length]]);
  const tabs = list.filter((s) => s.source === 'tab').length;
  if (tabs) out.set('tabs', tabs);
  for (const s of list) {
    if (s.kind === 'nomi') continue;
    out.set(s.kind, (out.get(s.kind) ?? 0) + 1);
  }
  return [...out.entries()];
}
