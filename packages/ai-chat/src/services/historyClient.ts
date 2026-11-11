import { BUILTIN_CLI_IDS, cliCapability, type BuiltinCliId } from '@nomi-ai/cli-catalog';
import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import type { HarnessTabMeta } from './harnessClient';

export type HistoryBackend = BuiltinCliId;
/** 能列出以前会话的编程助手（清单 capabilities.history） */
export const HISTORY_BACKENDS: readonly HistoryBackend[] = BUILTIN_CLI_IDS.filter((id) =>
  cliCapability(id, 'history'),
);

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

export interface HistoryDeleteResult {
  ok: boolean;
  /** 移到废纸篓的文件 / 目录数 */
  removed?: number;
  error?: string;
}

/** 没有契约传输（浏览器预览 / 测试）时调用失败；契约错误换成普通 Error（只保留文案，与原 IPC 一致） */
async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.mascot-theme.coding-agent-harness-requires-the-desktop-app'));
  try {
    return (await run()) as T;
  } catch (e) {
    throw e instanceof Error ? new Error(e.message) : e;
  }
}

export const historyClient = {
  /** 确认后由内核读取标签的最新会话标识，终止进程并删除记录 */
  deleteTab: (id: string) => call<HistoryDeleteResult>(() => api.history.deleteTab({ id })),
  available: () => hasTransport(),
  list: (backend: HistoryBackend, o: { offset?: number; limit?: number; force?: boolean } = {}) =>
    call<HistoryPage>(() => api.history.list({ backend, options: o })),
  /** 搜索用的紧凑索引（主进程增量解析，分块返回） */
  index: (backend: HistoryBackend, o: { offset?: number; limit?: number; force?: boolean } = {}) =>
    call<HistoryPage>(() => api.history.index({ backend, options: o })),
  open: (backend: HistoryBackend, sessionId: string) =>
    call<HistoryOpenResult>(() => api.history.open({ backend, sessionId })),
  /** 内核先关闭对应标签并等待 CLI 进程退出，再永久删除会话记录 */
  delete: (backend: HistoryBackend, sessionId: string) =>
    call<HistoryDeleteResult>(() => api.history.delete({ backend, sessionId })),
};

export const isHistoryBackend = (b: string): b is HistoryBackend =>
  (HISTORY_BACKENDS as readonly string[]).includes(b);
