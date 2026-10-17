import { t } from '@nomi-ai/ui';

export type HarnessBackend = 'nomi' | 'claude' | 'codex' | 'dsh' | 'grok';

export interface HarnessState {
  backend: HarnessBackend;
  cwd: string;
  cliSessionId: string | null;
  busy: boolean;
  toolsDisabled: boolean;
  bins: Record<string, string | null>;
}

export type HarnessTabStatus = 'idle' | 'queued' | 'running' | 'error';

export interface HarnessTabMeta {
  id: string;
  title: string;
  backend: HarnessBackend;
  cwd: string;
  cliSessionId: string | null;
  status: HarnessTabStatus;
  unread: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface HarnessTabsState {
  tabs: HarnessTabMeta[];
  activeTabId: string;
  maxConcurrent: number;
  running: number;
  queued: number;
}

export interface HarnessTabMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  error?: boolean;
  tools?: string[];
  /** 本轮工具调用 / 思考的结构化轨迹 */
  trace?: HarnessTraceEvent[];
  durationMs?: number;
  usage?: HarnessUsage;
  stopped?: true;
}

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** 工具调用 / 思考事件（主进程 stampEvent 带 at 时间戳；detail 为调用 id，codex 为命令行） */
export type HarnessTraceEvent =
  | {
      type: 'tool';
      name: string;
      status: 'start' | 'done' | 'error';
      detail?: string;
      id?: string;
      input?: string;
      output?: string;
      parentId?: string;
      at?: number;
    }
  | { type: 'thinking'; text: string; at?: number };

export type HarnessLiveEvent =
  | { tabId: string; type: 'text-delta' | 'text'; text: string }
  | ({ tabId: string } & Extract<HarnessTraceEvent, { type: 'tool' }>)
  | ({ tabId: string } & Extract<HarnessTraceEvent, { type: 'thinking' }>)
  | {
      tabId: string;
      type: 'status';
      kind: 'retry' | 'reconnect' | 'compact' | 'clear';
      text?: string;
      attempt?: number;
      max?: number;
    }
  | { tabId: string; type: 'done'; text: string; sessionId?: string; usage?: HarnessUsage }
  | { tabId: string; type: 'error'; message: string }
  | { tabId: string; type: 'permission'; id: string; summary: string };

export const MAIN_TAB_ID = 'main';

export interface HarnessSendResult {
  text: string;
  sessionId: string | null;
  /** 本轮轨迹 / 耗时 / 用量（主进程 sendTab 填充） */
  trace?: HarnessTraceEvent[];
  durationMs?: number;
  usage?: HarnessUsage;
}

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
  if (!b) throw new Error(t('编程助手接入需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:harness:${method}`, ...args)) as T & {
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const harnessClient = {
  available: () => !!bridge(),
  state: () => call<HarnessState>('state'),
  setBackend: (b: HarnessBackend) => call<HarnessState>('set-backend', b),
  setCwd: (c: string) => call<HarnessState>('set-cwd', c),
  pickCwd: () => call<HarnessState>('pick-cwd'),
  send: (prompt: string) => call<HarnessSendResult>('send', prompt),
  onChanged: (fn: (s: HarnessState) => void) =>
    bridge()?.on('ai:harness:changed', (p) => fn(p as HarnessState)) ?? (() => undefined),
  onEvent: (fn: (e: unknown) => void) => bridge()?.on('ai:harness:event', fn) ?? (() => undefined),
  /** 主进程按帧合批后的实时事件（相邻 text-delta 已拼接） */
  onEvents: (fn: (batch: unknown[]) => void) =>
    bridge()?.on('ai:harness:events', (p) => {
      if (Array.isArray(p)) fn(p);
    }) ?? (() => undefined),
  tabs: () => call<HarnessTabsState>('tabs'),
  createTab: (o: {
    backend: HarnessBackend;
    cwd?: string;
    title?: string;
    messages?: HarnessTabMessage[];
  }) => call<HarnessTabMeta>('tab-create', o),
  seedTabMessages: (id: string, messages: HarnessTabMessage[]) =>
    call<HarnessTabMeta>('tab-seed', id, messages),
  closeTab: (id: string) => call<HarnessTabsState>('tab-close', id),
  renameTab: (id: string, title: string) => call<HarnessTabMeta>('tab-rename', id, title),
  activateTab: (id: string) => call<HarnessTabsState>('tab-activate', id),
  setTabBackend: (id: string, b: HarnessBackend) => call<HarnessTabMeta>('tab-backend', id, b),
  setTabCwd: (id: string, cwd: string) => call<HarnessTabMeta>('tab-cwd', id, cwd),
  /** 原生文件夹选择器（不绑定标签）；取消返回 null */
  pickDir: (defaultPath?: string) => call<string | null>('pick-dir', defaultPath),
  recentCwds: () => call<string[]>('recent-cwds'),
  pickTabCwd: (id: string) => call<HarnessTabMeta>('tab-pick-cwd', id),
  tabMessages: (id: string) => call<HarnessTabMessage[]>('tab-messages', id),
  sendTab: (id: string, prompt: string) => call<HarnessSendResult>('tab-send', id, prompt),
  cancelTab: (id: string) => call<boolean>('tab-cancel', id),
  setMaxConcurrent: (n: number) => call<HarnessTabsState>('set-max-concurrent', n),
  /** 允许/拒绝 Claude 工具权限请求 */
  replyPermission: (tabId: string, requestId: string, allow: boolean) =>
    call<boolean>('reply-permission', tabId, requestId, allow),
  onTabs: (fn: (s: HarnessTabsState) => void) =>
    bridge()?.on('ai:harness:tabs', (p) => fn(p as HarnessTabsState)) ?? (() => undefined),
  onTabMessage: (fn: (e: { tabId: string; message: HarnessTabMessage }) => void) =>
    bridge()?.on('ai:harness:tab-message', (p) =>
      fn(p as { tabId: string; message: HarnessTabMessage }),
    ) ?? (() => undefined),
};
