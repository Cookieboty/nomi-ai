import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';

/** 编程助手进度客户端：契约 `agents.*`（services/api） */
export type AgentKind = 'codex' | 'claude' | 'dsh' | 'grok' | 'gemini';
export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stalled' | 'idle';

export interface AgentWatchSettings {
  enabled: boolean;
  stallMs: number;
  cooldownMs: number;
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
  gemini: 'Gemini CLI',
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'ui.chat-settings.in-progress',
  completed: 'ui.foundation.done',
  failed: 'ui.foundation.failed',
  stalled: 'ui.chat-settings.may-be-stuck',
  waiting: 'ui.mascot-theme.waiting-for-you',
  idle: 'ui.mascot-theme.ended',
};

/** 没有契约传输（浏览器预览 / 测试）时调用失败；契约错误换成普通 Error（只保留文案，与原 IPC 一致） */
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.chat-settings.coding-agent-watching-requires-the-desktop-app'));
  try {
    return (await run()) as T;
  } catch (e) {
    throw e instanceof Error ? new Error(e.message) : e;
  }
}

export const agentsClient = {
  available: () => hasTransport(),
  state: () => call<AgentWatchState>(() => api.agents.state()),
  setSettings: (
    p: Omit<Partial<AgentWatchSettings>, 'tools'> & {
      tools?: Partial<Record<AgentKind, boolean>>;
    },
  ) => call<AgentWatchSettings>(() => api.agents.setSettings(p as never)),
  scan: () => call<AgentWatchState>(() => api.agents.scan()),
  onChanged: (fn: () => void) =>
    hasTransport() ? api.on('agents.changed', () => fn()) : () => undefined,
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
