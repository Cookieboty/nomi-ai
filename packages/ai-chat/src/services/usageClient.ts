/**
 * 用量与计费客户端：应用契约 `usage.*`（主进程 usage/UsageService）。
 * 类型与主进程 electron/src/usage 的返回结构一一对应（渲染进程不引用主进程代码）。
 */
import { t } from '@nomi-ai/ui';

import { api, hasTransport } from './api';

export type UsageRangeId = 'today' | '7d' | '30d' | '90d';
export type UsageCurrency = 'USD' | 'CNY';
export type UsageRetention = '90d' | '1y' | 'forever';

export interface UsageCustomPrice {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** models.dev 手动价格同步的状态（count = 0 表示从没同步过，用内置表） */
export interface UsagePriceSyncState {
  count: number;
  fetchedAt: number;
  checkedAt: number;
  tableDate: string;
}

export type UsagePriceSyncResult =
  | { ok: true; status: 'updated' | 'not-modified'; count: number; skipped: number }
  | {
      ok: false;
      reason: 'network' | 'timeout' | 'http' | 'invalid' | 'too-large' | 'busy';
      httpStatus?: number;
    };

export interface UsageSettings {
  enabled: boolean;
  readToolLogs: boolean;
  /** 点「刷新」时才拉起官方 CLI 去取额度（claude -p /usage、codex app-server）；关闭后只重读本机已有数据 */
  activeQuotaRefresh: boolean;
  retention: UsageRetention;
  currency: UsageCurrency;
  cnyPerUsd: number;
  customPrices: UsageCustomPrice[];
  clearedAt: number;
  /** 日 / 月预算、单任务提醒线（当前币种金额；0 = 不提醒） */
  dailyBudget: number;
  monthlyBudget: number;
  taskAlert: number;
  /** 启动时自动同步模型数据（价格 + 模型参数）；距上次核对不足 12 小时不同步 */
  modelsSyncAuto?: boolean;
}

export interface UsageBuiltinPrice extends UsageCustomPrice {
  label?: string;
  note?: string;
  /** 长上下文分档：单次请求提示词超过 size 时的价格 */
  tiers?: Array<{ size: number; input: number; output: number }>;
}

export interface UsageState {
  settings: UsageSettings;
  detected: string[];
  records: number;
  lastScanAt: number;
  /** degraded = 最近一次写盘失败，pendingRecords 条记录还在内存里等待重试 */
  persist?: { degraded: boolean; pendingRecords: number; cursorDirty: boolean };
  pricing: { date: string; builtin: UsageBuiltinPrice[]; sync?: UsagePriceSyncState };
}

export interface UsageSummary {
  costUsd: number;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  estimatedCalls: number;
  unpriced: Array<{ model: string; tokens: number; calls: number }>;
  /** 缓存命中率 = 缓存读 / (未命中输入 + 缓存读)；没有输入时为 null（旧主进程没有这个字段） */
  cacheHitRate?: number | null;
}

export interface UsageSeriesPoint {
  t: number;
  input: number;
  output: number;
  tokens: number;
  costUsd: number;
  calls: number;
}

export interface UsageBreakdownRow {
  key: string;
  tokens: number;
  input: number;
  output: number;
  costUsd: number;
  calls: number;
  hasUnpriced: boolean;
}

export interface UsageQueryResult {
  range: { id: UsageRangeId; from: number; to: number; bucket: 'hour' | 'day' };
  summary: UsageSummary;
  prev: UsageSummary;
  series: UsageSeriesPoint[];
  bySource: UsageBreakdownRow[];
  byProvider: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
}

export interface UsageHeatDay {
  date: string;
  tokens: number;
  costUsd: number;
  calls: number;
}

export type UsageDetailSort = 'ts' | 'tokens' | 'cost' | 'model' | 'source';

export interface UsageDetailQuery {
  from: number;
  to: number;
  source?: string;
  model?: string;
  session?: string;
  sort?: UsageDetailSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface UsageDetailRow {
  key: string;
  ts: number;
  source: string;
  provider: string;
  model: string;
  session?: string;
  project?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  /** null = 未定价 */
  costUsd: number | null;
  estimated: boolean;
}

export interface UsageDetailResult {
  rows: UsageDetailRow[];
  total: number;
  summary: UsageSummary;
  facets: { sources: string[]; models: string[]; sessions: Array<{ id: string; label: string }> };
}

/** 订阅额度的一个窗口（例如 5 小时 / 每周） */
export interface UsageQuotaWindow {
  id: string;
  usedPercent: number;
  windowMinutes?: number;
  resetAt?: number;
  /** 重置时间已过：这个百分比是上一个窗口的数据 */
  expired?: boolean;
}

/** 一个工具 / 来源的额度；status = unavailable 时显示「暂未返回可用额度」 */
export interface UsageQuotaEntry {
  id: string;
  label: string;
  /** ok = 有额度；unavailable = 订阅登录但暂未返回；api = API 计费，没有订阅额度 */
  status: 'ok' | 'unavailable' | 'api';
  /** 登录方式（主进程按官方登录状态命令 / 本地配置判断，不读取凭据） */
  auth?: 'subscription' | 'api' | 'unknown';
  windows: UsageQuotaWindow[];
  updatedAt?: number;
  plan?: string;
  /** 这份数字的来源：状态栏快照 / claude /usage / Codex app-server / Grok ACP */
  origin?: 'statusline' | 'usage-cmd' | 'session-log' | 'app-server' | 'grok-acp';
  /** 最近一次刷新暂时失败，显示的是更早读到的值 */
  stale?: boolean;
}

/** 某个工具这次刷新的结果（不含任何账号信息） */
export type UsageToolRefresh =
  | { state: 'fresh-local' }
  | { state: 'ok' }
  | { state: 'throttled'; retryInSec: number }
  | { state: 'transient'; reason: string; stale: boolean }
  | { state: 'auth'; reason: string }
  | { state: 'skipped'; reason: 'disabled' | 'not-subscription' };

/** 支持单独刷新额度的工具（官方 CLI 能返回订阅额度的几个） */
export type UsageQuotaTool = 'claude' | 'codex' | 'grok';
export const USAGE_QUOTA_TOOLS: readonly UsageQuotaTool[] = ['claude', 'codex', 'grok'];

export interface UsageQuotaRefresh {
  entries: UsageQuotaEntry[];
  tools: Partial<Record<UsageQuotaTool, UsageToolRefresh>>;
}

/** 某一端（nomi / claude / codex / dsh / grok）的用量聚合，供「按端」信息卡 / 详情抽屉使用 */
export interface UsageEndpointInfo {
  source: string;
  today: UsageSummary;
  week: UsageSummary;
  /** 近 7 天按天（旧 → 新） */
  series: UsageSeriesPoint[];
  byModel: UsageBreakdownRow[];
  byProvider: UsageBreakdownRow[];
  lastActivityAt: number | null;
}

/** Claude Code 额度来源：用户可选开启的 statusline 快照 */
export interface UsageQuotaHook {
  supported: boolean;
  enabled: boolean;
  hadOwnStatusLine: boolean;
  hasSnapshot: boolean;
  problem?: 'invalid-settings' | 'unsupported-statusline';
}

/** 在桌面应用里（有契约传输）才能调用用量服务 */
export const usageClientAvailable = (): boolean => hasTransport();

async function call<T>(fn: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new Error(t('ui.usage-tools.usage-statistics-require-the-desktop-app'));
  return (await fn()) as T;
}

export const usageClient = {
  available: () => hasTransport(),
  state: () => call<UsageState>(() => api.usage.state()),
  query: (range: UsageRangeId) => call<UsageQueryResult>(() => api.usage.query({ range })),
  heatmap: () => call<{ days: UsageHeatDay[]; today: string }>(() => api.usage.heatmap()),
  details: (q: UsageDetailQuery) => call<UsageDetailResult>(() => api.usage.details(q)),
  csv: (q: UsageDetailQuery) => call<string>(() => api.usage.csv(q)),
  setSettings: (p: Partial<UsageSettings>) => call<UsageSettings>(() => api.usage.setSettings(p)),
  scan: () => call<UsageState & { added: number; files: number }>(() => api.usage.scan()),
  /** 手动同步价格：只在用户点击时调用；只下载 models.dev 的公开价格表，不上传任何用量 */
  syncPrices: () =>
    call<UsageState & { result: UsagePriceSyncResult }>(() => api.usage.priceSync()),
  clear: () => call<UsageState>(() => api.usage.clear()),
  quota: () => call<UsageQuotaEntry[]>(() => api.usage.quota()),
  /** 不带参数 = 全部刷新（并行）；带工具 id = 只刷新这一个工具，互不阻塞 */
  quotaRefresh: (tool?: UsageQuotaTool) =>
    call<UsageQuotaRefresh>(() => api.usage.quotaRefresh(tool ? { tool } : {})),
  endpoint: (source: string) => call<UsageEndpointInfo>(() => api.usage.endpoint({ source })),
  quotaHook: () => call<UsageQuotaHook>(() => api.usage.quotaHook()),
  setQuotaHook: (enabled: boolean) =>
    call<UsageQuotaHook>(() => api.usage.quotaHookSet({ enabled })),
  onChanged: (fn: () => void) =>
    hasTransport() ? api.on('usage.changed', () => fn()) : () => undefined,
};

/** 来源 → 展示名（Nomi 对话 / 各编程工具 / 其他） */
export const USAGE_SOURCE_LABEL: Record<string, string> = {
  nomi: 'ui.usage-tools.nomi-chat',
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  grok: 'Grok',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot CLI',
  kimi: 'Kimi',
  aider: 'Aider',
  cline: 'Cline',
  continue: 'Continue',
  cursor: 'Cursor',
  other: 'ui.usage-tools.other-providers',
};
