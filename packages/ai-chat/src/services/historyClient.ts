import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
import { t } from '@nomi-ai/ui';

import type { HarnessTabMeta } from './harnessClient';

export type HistoryBackend = BuiltinCliId;
export const HISTORY_BACKENDS: readonly HistoryBackend[] = [
  'claude',
  'codex',
  'dsh',
  'gemini',
  'grok',
];

/** 列表 / 搜索索引每页条数（须与主进程 SessionHistoryService.HISTORY_PAGE_SIZE 一致） */
export const HISTORY_PAGE_SIZE = 20;
/** 历史会话最多展示条数（须与主进程 HISTORY_MAX_ITEMS 一致，按 mtime 取最近 N 条） */
export const HISTORY_MAX_ITEMS = 500;

/** 会话由哪个客户端创建（须与主进程 HistoryClient 一致） */
export type HistoryClient = 'cli' | 'desktop' | 'ide' | 'exec' | 'nomi';
/** 线路：官方 / Nomi 网关 / 其他自定义供应商 */
export type HistoryRoute = 'official' | 'gateway' | 'custom';

export interface HistorySession {
  key: string;
  backend: HistoryBackend;
  sessionId: string;
  title: string;
  cwd?: string;
  cwdMissing: boolean;
  updatedAt: number;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  client?: HistoryClient;
  route?: HistoryRoute;
  /** 线路为 custom 时的供应商名 */
  provider?: string;
  /** 创建会话的官方账号（邮箱或名称） */
  account?: string;
}

export interface HistoryPage {
  items: HistorySession[];
  /** 主进程返回的不透明游标；调用方不应假设它对应文件下标。 */
  nextOffset: number | null;
  hasMore: boolean;
}

export interface HistoryOpenResult {
  ok: boolean;
  tab?: HarnessTabMeta;
  reused?: boolean;
  notice?: string;
  error?: string;
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}
const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('编程助手接入需要在桌面应用中使用'));
  const r = (await b.invoke(channel, ...args)) as T & { __error?: { message: string } };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

export const historyClient = {
  available: () => !!bridge(),
  list: (backend: HistoryBackend, o: { offset?: number; limit?: number; force?: boolean } = {}) =>
    call<HistoryPage>('ai:history:list', backend, o),
  /** 搜索用的紧凑索引（主进程增量解析，分块返回） */
  index: (backend: HistoryBackend, o: { offset?: number; limit?: number; force?: boolean } = {}) =>
    call<HistoryPage>('ai:history:index', backend, o),
  open: (backend: HistoryBackend, sessionId: string) =>
    call<HistoryOpenResult>('ai:history:open', backend, sessionId),
};
