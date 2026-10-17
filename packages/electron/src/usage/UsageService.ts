/**
 * 用量与计费服务（主进程）：
 * - 采集：Nomi 对话（响应 usage，没有才估算并标「估算」）/ 本地路由经过的请求 / 编程工具会话日志；
 * - 存储：userData/usage/ledger.jsonl（只在本机，不上传）；设置 userData/usage/settings.json；
 * - 查询：汇总 / 趋势 / 分布 / 排行 / 热力图 / 明细 / CSV，费用按 USD 算、界面换算币种；
 * - 隐私：总开关、是否读取编程工具日志、保留时长、一键清空。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, ipcMain } from 'electron';

import { t as tr } from '../i18n';
import { isTrustedSenderUrl } from '../security/ipcSenderGuard';
import { writePrivateFile } from '../utils/privateFile';

import {
  breakdown,
  dateKey,
  details,
  heatmap,
  makePriceOf,
  rangeOf,
  recordCost,
  startOfDay,
  totalTokens,
  series,
  summarize,
  toCsv,
  toRow,
  type DetailQuery,
  type Labels,
  type RangeId,
} from './aggregate';
import { AuthModeDetector, applyAuthModes, type AuthDeps, type AuthMode } from './authMode';
import {
  disableHook,
  enableHook,
  hookStatus,
  readStatuslineSnapshot,
  SNAPSHOT_FILE,
  type HookStatus,
} from './claudeStatusline';
import { ClaudeUsageFetcher, type ClaudeFetcherDeps } from './claudeSubscription';
import { CodexRateLimitReader, type CodexRpcDeps } from './codexRateLimits';
import { formatAmount, formatMoney, formatTokens } from './money';
import { PriceSync, type PriceSyncResult } from './priceSync';
import {
  BUILTIN_PRICES,
  DEFAULT_CNY_PER_USD,
  PRICING_TABLE_DATE,
  sanitizeCustomPrices,
} from './pricing';
import {
  QuotaRegistry,
  sanitizeWindows,
  type QuotaEntry,
  type QuotaOrigin,
  type QuotaReading,
  type QuotaWindow,
} from './quota';
import { IdentityQuotaCache, type RefreshResult } from './quotaCache';
import { loadSalt } from './quotaIdentity';
import type { SniffedUsage } from './sniff';
import type { CustomPrice, Currency, UsageRecord, UsageSource } from './types';
import { UsageLedger, type Retention } from './UsageLedger';
import { UsageLogScanner } from './UsageLogScanner';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export interface UsageSettings {
  /** 总开关：关闭后不记录、不读取日志（已有数据保留，可一键清空） */
  enabled: boolean;
  /** 读取本机编程工具自己的会话日志（Claude Code / Codex / dsh …） */
  readToolLogs: boolean;
  /**
   * 主动刷新额度：用户点「刷新」时，才拉起官方 CLI（claude -p /usage、codex app-server）去取额度。
   * 关闭后刷新只重读本机已有的数据（会话日志 / 状态栏快照），不会启动任何 CLI。
   */
  activeQuotaRefresh: boolean;
  retention: Retention;
  currency: Currency;
  /** 1 USD = ? CNY；默认只是占位常量，界面标注「可自定义」 */
  cnyPerUsd: number;
  /** 用户改价 / 新增的模型单价（USD / 1M tokens） */
  customPrices: CustomPrice[];
  /** 上次「一键清空」的时间（ms）；早于它的日志内容不再导入 */
  clearedAt: number;
  /** 预算与提醒线（以当前币种计；0 = 不提醒）。切换币种时按汇率自动换算 */
  dailyBudget: number;
  monthlyBudget: number;
  /** 单个任务（连续使用的一段会话）花费超过它就提醒一次 */
  taskAlert: number;
}

export const DEFAULT_USAGE_SETTINGS: UsageSettings = {
  enabled: true,
  readToolLogs: true,
  activeQuotaRefresh: true,
  retention: '1y',
  currency: 'USD',
  cnyPerUsd: DEFAULT_CNY_PER_USD,
  customPrices: [],
  clearedAt: 0,
  dailyBudget: 0,
  monthlyBudget: 0,
  taskAlert: 0,
};

export function sanitizeUsageSettings(
  raw: unknown,
  base: UsageSettings = DEFAULT_USAGE_SETTINGS,
): UsageSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageSettings>;
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    enabled: b(o.enabled, base.enabled),
    readToolLogs: b(o.readToolLogs, base.readToolLogs),
    activeQuotaRefresh: b(o.activeQuotaRefresh, base.activeQuotaRefresh),
    retention:
      o.retention === '90d' || o.retention === '1y' || o.retention === 'forever'
        ? o.retention
        : base.retention,
    currency: o.currency === 'CNY' || o.currency === 'USD' ? o.currency : base.currency,
    cnyPerUsd:
      typeof o.cnyPerUsd === 'number' && o.cnyPerUsd > 0 && o.cnyPerUsd < 1000
        ? o.cnyPerUsd
        : base.cnyPerUsd,
    customPrices:
      o.customPrices === undefined ? base.customPrices : sanitizeCustomPrices(o.customPrices),
    clearedAt: typeof o.clearedAt === 'number' && o.clearedAt >= 0 ? o.clearedAt : base.clearedAt,
    dailyBudget: amount(o.dailyBudget, base.dailyBudget),
    monthlyBudget: amount(o.monthlyBudget, base.monthlyBudget),
    taskAlert: amount(o.taskAlert, base.taskAlert),
  };
}

/** 预算 / 阈值：有限的非负数（最多两位小数），非法值回落到默认 */
function amount(v: unknown, d: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e7) return d;
  return Math.round(v * 100) / 100;
}

type Deps = {
  root: string;
  logger: Logger;
  home?: string;
  dshHome?: string;
  now?: () => number;
  /** 日志扫描间隔（ms），默认 60s；0 = 不自动扫描（测试） */
  scanMs?: number;
  /** Nomi 供应商 id → 显示名 */
  providerName?: (id: string) => string | undefined;
  /**
   * 弹出一条提醒（看板娘气泡 + 灵动岛）。返回 false = 当前不方便（免打扰等），稍后会重试，
   * 且这条提醒不算「已提醒」。
   */
  alert?: (a: UsageAlert) => boolean;
  /** 登录方式探测：运行官方「登录状态」命令（测试注入）；默认调用本机 claude / codex CLI */
  authRun?: AuthDeps['run'];
  /** 平台（测试注入）：statusline 快照脚本需要 sh，Windows 暂不支持 */
  platform?: NodeJS.Platform;
  /** 环境变量（测试注入）：CLAUDE_CONFIG_DIR / CODEX_HOME 等；默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 主动刷新额度所用的官方 CLI 调用（测试注入） */
  claudeUsage?: ClaudeFetcherDeps;
  codexRpc?: Partial<CodexRpcDeps>;
  /** 价格同步所用的 fetch（测试注入；默认全局 fetch，只在用户点「同步价格」时调用） */
  priceFetch?: (url: string, init: RequestInit) => Promise<Response>;
};

/** 单个工具这次「刷新」的结果（面板提示用，不含任何账号信息） */
export type ToolRefresh =
  | { state: 'fresh-local' }
  | { state: 'ok' }
  | { state: 'throttled'; retryInSec: number }
  | { state: 'transient'; reason: string; stale: boolean }
  | { state: 'auth'; reason: string }
  | { state: 'skipped'; reason: 'disabled' | 'not-subscription' };

export interface QuotaRefreshReport {
  entries: QuotaEntry[];
  tools: Partial<Record<'claude' | 'codex', ToolRefresh>>;
}

/** 本机已有的额度快照多久算「还新」：更新鲜就不拉起官方 CLI */
export const QUOTA_FRESH_MS = 5 * 60_000;

type CodexStore = {
  ts: number;
  windows: QuotaWindow[];
  plan?: string;
  origin: QuotaOrigin;
};

export interface UsageAlert {
  kind: 'budget-80' | 'budget-100' | 'task';
  title: string;
  text: string;
}

/** 某个会话 / 任务的累计用量 */
export interface SessionUsage {
  tokens: number;
  /** 已定价部分的费用（USD）；null = 这段用量全部来自未定价模型 */
  costUsd: number | null;
  calls: number;
  /** 其中有未定价模型（费用不完整） */
  unpriced: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  nomi: 'Nomi',
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
  other: 'other',
};

/** 同一个会话两次调用相隔超过它，就当作新的一个任务 */
const TASK_GAP_MS = 10 * 60_000;
/** 只对这么近的记录做单任务提醒（避免首次导入历史日志时刷屏） */
const TASK_FRESH_MS = 30 * 60_000;
const BUDGET_CHECK_MS = 5 * 60_000;

interface BudgetAlertState {
  day: string;
  dayLevel: 0 | 80 | 100;
  month: string;
  monthLevel: 0 | 80 | 100;
}

/** 一条调用的原始数据（主进程各采集点统一走这里） */
export interface UsageInput {
  ts: number;
  dur?: number;
  source: UsageSource;
  via: UsageRecord['via'];
  provider?: string;
  model: string;
  /** 输入 token 总数（含缓存部分）——Nomi 对话口径 */
  promptTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  est?: boolean;
  session?: string;
  project?: string;
  /** 去重键；不传则按来源 + 时间 + token 生成 */
  key?: string;
}

function accumulate(
  e: SessionUsage,
  r: UsageRecord,
  priceOf: ReturnType<typeof makePriceOf>,
): void {
  e.tokens += totalTokens(r);
  e.calls++;
  const c = recordCost(r, priceOf);
  if (c === null) e.unpriced = true;
  else e.costUsd = (e.costUsd ?? 0) + c;
}

export class UsageService {
  readonly ledger: UsageLedger;
  private settings: UsageSettings = { ...DEFAULT_USAGE_SETTINGS };
  private readonly settingsPath: string;
  private readonly scanner: UsageLogScanner;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastScanAt = 0;
  private scanning = false;
  /** 正在经过本地路由的请求数（按来源）：这段时间不读该来源的日志，避免同一次请求记两份 */
  private readonly routeInflight = new Map<UsageSource, number>();
  private seq = 0;
  private listeners = new Set<(r: UsageRecord) => void>();
  private readonly alertsPath: string;
  private alertState: BudgetAlertState = { day: '', dayLevel: 0, month: '', monthLevel: 0 };
  private budgetTimer: ReturnType<typeof setInterval> | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tasks = new Map<
    string,
    { last: number; parts: Map<string, number>; alerted: boolean }
  >();
  private readonly quotaPath: string;
  /** Codex 日志里最近一次额度快照（落盘，重启后还能看到上次的） */
  private codexQuota: CodexStore | null = null;
  /** 账号变化 / 认证失效后，早于这个时间的日志额度快照不再采用（避免旧账号的数字回流） */
  private quotaFloor = 0;
  /** 上次读到的账号指纹（非敏感，见 quotaIdentity.ts）：用来发现换号 */
  private codexFp: string | null = null;
  private claudeFp: string | null = null;
  private readonly salt: string;
  /** models.dev 价格同步（只在用户点击时联网）：覆盖层缓存在 userData */
  readonly priceSync: PriceSync;
  private readonly claudeCache: IdentityQuotaCache;
  private readonly codexCache: IdentityQuotaCache;
  private readonly claudeFetcher: ClaudeUsageFetcher;
  private readonly codexReader: CodexRateLimitReader;
  private refreshing: Promise<QuotaRefreshReport> | null = null;
  readonly quotaSources = new QuotaRegistry();
  private readonly auth: AuthModeDetector;
  private sessionCache: {
    ver: number;
    prices: unknown;
    priceVer: number;
    map: Map<string, SessionUsage>;
  } | null = null;

  constructor(private readonly d: Deps) {
    fs.mkdirSync(d.root, { recursive: true });
    this.settingsPath = path.join(d.root, 'settings.json');
    this.alertsPath = path.join(d.root, 'alerts.json');
    this.quotaPath = path.join(d.root, 'quota.json');
    this.priceSync = new PriceSync({
      root: d.root,
      now: d.now,
      fetchImpl: d.priceFetch,
      logger: d.logger,
    });
    this.load();
    this.loadAlerts();
    this.salt = loadSalt(d.root);
    this.claudeCache = new IdentityQuotaCache(() => this.now());
    this.codexCache = new IdentityQuotaCache(() => this.now());
    this.loadQuota();
    this.claudeFetcher = new ClaudeUsageFetcher({ now: d.now, ...d.claudeUsage });
    this.codexReader = new CodexRateLimitReader({
      now: d.now,
      salt: () => this.salt,
      ...d.codexRpc,
    });
    this.auth = new AuthModeDetector({
      home: d.home,
      env: d.env,
      now: d.now,
      run: d.authRun,
      salt: () => this.salt,
      // 日志 / 快照里已经有带额度的数据，说明是订阅登录
      hasSubscriptionData: (id) =>
        id === 'codex' ? !!this.codexQuota?.plan : !!readStatuslineSnapshot(d.root),
    });
    this.quotaSources.register({
      id: 'codex',
      label: 'Codex',
      read: () =>
        this.settings.enabled &&
        this.codexQuota &&
        (this.codexQuota.origin === 'app-server' || this.settings.readToolLogs)
          ? {
              windows: this.codexQuota.windows,
              updatedAt: this.codexQuota.ts,
              plan: this.codexQuota.plan,
              origin: this.codexQuota.origin,
              ...(this.codexQuota.origin === 'app-server' && this.codexCache.isStale()
                ? { stale: true }
                : {}),
            }
          : null,
    });
    this.quotaSources.register({
      id: 'claude',
      label: 'Claude Code',
      // 状态栏快照（用户开启后由官方 statusline 输入里的 rate_limits 提供）与「刷新」时
      // `claude -p /usage` 取到的值，谁新用谁
      read: () => {
        if (!this.settings.enabled) return null;
        const snap = readStatuslineSnapshot(this.d.root);
        const snapR: QuotaReading | null = snap ? { ...snap, origin: 'statusline' } : null;
        const cmd = this.claudeCache.get();
        if (snapR && cmd) return snapR.updatedAt >= cmd.updatedAt ? snapR : cmd;
        return snapR ?? cmd;
      },
    });
    this.ledger = new UsageLedger({ root: d.root, logger: d.logger, now: d.now });
    this.scanner = new UsageLogScanner({
      ledger: this.ledger,
      home: d.home,
      dshHome: d.dshHome,
      env: d.env,
      now: d.now,
      logger: d.logger,
      retention: () => this.settings.retention,
      clearedAt: () => this.settings.clearedAt,
      routeBusy: (s) => (this.routeInflight.get(s) ?? 0) > 0,
      onNew: (r) => this.afterRecord(r),
      onQuota: (q) => this.setCodexQuota(q),
    });
    this.ledger.prune(this.settings.retention);
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private load(): void {
    try {
      this.settings = sanitizeUsageSettings(JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')));
    } catch {
      this.settings = sanitizeUsageSettings({});
    }
  }

  private save(): void {
    writePrivateFile(this.settingsPath, JSON.stringify(this.settings, null, 2));
  }

  private loadAlerts(): void {
    try {
      const o = JSON.parse(fs.readFileSync(this.alertsPath, 'utf8')) as Partial<BudgetAlertState>;
      const lv = (v: unknown): 0 | 80 | 100 => (v === 80 || v === 100 ? v : 0);
      this.alertState = {
        day: typeof o.day === 'string' ? o.day : '',
        dayLevel: lv(o.dayLevel),
        month: typeof o.month === 'string' ? o.month : '',
        monthLevel: lv(o.monthLevel),
      };
    } catch {
      /* 没有记录 = 都还没提醒过 */
    }
  }

  private loadQuota(): void {
    try {
      const o = JSON.parse(fs.readFileSync(this.quotaPath, 'utf8')) as {
        codex?: { ts?: unknown; windows?: unknown; plan?: unknown; origin?: unknown };
        codexFp?: unknown;
        claudeFp?: unknown;
        floor?: unknown;
      };
      const fp = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{16}$/.test(v) ? v : null);
      this.codexFp = fp(o.codexFp);
      this.claudeFp = fp(o.claudeFp);
      this.codexCache.observeIdentity(this.codexFp);
      this.claudeCache.observeIdentity(this.claudeFp);
      if (typeof o.floor === 'number' && o.floor > 0) this.quotaFloor = o.floor;
      const c = o.codex;
      if (c && typeof c.ts === 'number' && Array.isArray(c.windows) && c.ts >= this.quotaFloor) {
        const windows = sanitizeWindows(c.windows as QuotaWindow[], 0);
        if (windows.length)
          this.codexQuota = {
            ts: c.ts,
            windows,
            origin: c.origin === 'app-server' ? 'app-server' : 'session-log',
            ...(typeof c.plan === 'string' ? { plan: c.plan } : {}),
          };
      }
    } catch {
      /* 没有快照 */
    }
  }

  private saveQuota(): void {
    try {
      writePrivateFile(
        this.quotaPath,
        JSON.stringify({
          ...(this.codexQuota ? { codex: this.codexQuota } : {}),
          ...(this.codexFp ? { codexFp: this.codexFp } : {}),
          ...(this.claudeFp ? { claudeFp: this.claudeFp } : {}),
          ...(this.quotaFloor ? { floor: this.quotaFloor } : {}),
        }),
      );
    } catch (e) {
      this.d.logger.warn('usage quota save failed', { e: String(e) });
    }
  }

  private setCodexQuota(q: { ts: number; windows: QuotaWindow[]; plan?: string }): void {
    this.storeCodexQuota({ ...q, origin: 'session-log' });
  }

  private storeCodexQuota(q: CodexStore): void {
    if (q.ts < this.quotaFloor) return;
    if (this.codexQuota && q.ts < this.codexQuota.ts) return;
    this.codexQuota = q;
    this.saveQuota();
    this.changed();
  }

  /** 换号 / 认证失效：清掉旧值，并让早于现在的日志快照不再回流 */
  private dropCodexQuota(floor = this.now()): void {
    this.codexQuota = null;
    this.quotaFloor = Math.max(this.quotaFloor, floor);
    this.saveQuota();
  }

  private dropClaudeQuota(): void {
    this.claudeCache.clear();
    fs.rmSync(path.join(this.d.root, SNAPSHOT_FILE), { force: true });
  }

  /** Claude 账号指纹变了（换号）：清掉状态栏快照和缓存里上一个账号的额度 */
  private observeClaudeIdentity(fp: string | null): void {
    if (!fp) return;
    if (this.claudeFp && this.claudeFp !== fp) this.dropClaudeQuota();
    if (this.claudeFp !== fp) {
      this.claudeFp = fp;
      this.saveQuota();
    }
    this.claudeCache.observeIdentity(fp);
  }

  /** 订阅额度：来源读不到就是「不可用」（面板显示「暂未返回可用额度」），从不估算 */
  quota(): QuotaEntry[] {
    return this.quotaSources.collect(this.now(), [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'dsh', label: 'dsh' },
      { id: 'grok', label: 'Grok' },
      { id: 'nomi', label: 'Nomi' },
    ]);
  }

  /**
   * 面板用：按登录方式过滤。订阅 / 账号登录才展示额度；API Key / 第三方供应商只显示「API 计费，无订阅额度」；
   * Nomi 对话走 API，不出现在额度卡里。
   */
  async quotaView(): Promise<QuotaEntry[]> {
    const modes: Record<string, AuthMode> = {};
    for (const id of ['claude', 'codex', 'dsh', 'grok', 'nomi']) {
      const info = await this.auth.detectFull(id).catch(() => null);
      modes[id] = info?.mode ?? 'unknown';
      if (id === 'claude' && info) this.observeClaudeIdentity(info.fp);
    }
    return applyAuthModes(this.quota(), modes, new Set(this.scanner.detected()));
  }

  /**
   * 用户点「刷新」：先重读本机已有的数据（会话日志）；快照缺失 / 过期 / 超过 5 分钟才会拉起官方 CLI：
   * - Claude Code：`claude -p /usage --output-format json`；
   * - Codex：`codex app-server` 的 `account/rateLimits/read`。
   * 两者都是官方 CLI 用自己的登录态去取，Nomi 不接触凭据；每个来源 60 秒内最多真实拉取一次；
   * 「主动刷新额度」关闭时一律不拉起 CLI。从不自动轮询，只在这里被调用时才会触发。
   */
  refreshQuota(): Promise<QuotaRefreshReport> {
    if (this.refreshing) return this.refreshing;
    const p = this.doRefreshQuota();
    this.refreshing = p;
    void p
      .finally(() => {
        if (this.refreshing === p) this.refreshing = null;
      })
      .catch(() => undefined);
    return p;
  }

  private fresh(r: QuotaReading | null): boolean {
    if (!r) return false;
    const now = this.now();
    if (now - r.updatedAt > QUOTA_FRESH_MS) return false;
    return !sanitizeWindows(r.windows, now).some((w) => w.expired);
  }

  private mapRefresh(r: RefreshResult, cache: IdentityQuotaCache): ToolRefresh {
    switch (r.state) {
      case 'ok':
        return { state: 'ok' };
      case 'throttled':
        return { state: 'throttled', retryInSec: Math.max(1, Math.ceil(cache.retryInMs() / 1000)) };
      case 'transient':
        return { state: 'transient', reason: r.reason, stale: r.stale };
      default:
        return { state: 'auth', reason: r.reason };
    }
  }

  private async doRefreshQuota(): Promise<QuotaRefreshReport> {
    const tools: QuotaRefreshReport['tools'] = {};
    if (this.settings.enabled && this.settings.readToolLogs)
      await this.scan().catch(() => undefined);
    // 重新问一遍官方登录状态（换号 / 退出登录马上生效）
    this.auth.invalidate();
    const active = this.settings.enabled && this.settings.activeQuotaRefresh;

    const cl = await this.auth.detectFull('claude').catch(() => null);
    if (cl) this.observeClaudeIdentity(cl.fp);
    if (cl?.mode === 'subscription') {
      if (!active) tools.claude = { state: 'skipped', reason: 'disabled' };
      else {
        const snap = readStatuslineSnapshot(this.d.root);
        if (this.fresh(snap) || this.fresh(this.claudeCache.get()))
          tools.claude = { state: 'fresh-local' };
        else {
          const r = await this.claudeCache.refresh(cl.fp, () => this.claudeFetcher.fetch(cl.plan));
          if (r.state === 'auth') this.dropClaudeQuota();
          tools.claude = this.mapRefresh(r, this.claudeCache);
        }
      }
    } else if (cl) tools.claude = { state: 'skipped', reason: 'not-subscription' };

    const cx = await this.auth.detectFull('codex').catch(() => null);
    if (cx?.mode === 'subscription') {
      if (!active) tools.codex = { state: 'skipped', reason: 'disabled' };
      else if (this.codexQuota && this.fresh({ ...this.codexQuota, updatedAt: this.codexQuota.ts }))
        tools.codex = { state: 'fresh-local' };
      else {
        const r = await this.codexCache.refresh(null, () => this.codexReader.fetch());
        if (r.state === 'auth') {
          this.codexFp = null;
          this.codexCache.clear();
          this.dropCodexQuota();
        } else if (r.state === 'ok') {
          const fp = this.codexCache.currentIdentity();
          const v = this.codexCache.get();
          // 换号：旧账号的值与更早的日志快照一起清掉
          if (this.codexFp && fp && this.codexFp !== fp)
            this.dropCodexQuota(v?.updatedAt ?? this.now());
          if (fp) this.codexFp = fp;
          if (v) {
            this.codexQuota = null;
            this.storeCodexQuota({
              ts: v.updatedAt,
              windows: v.windows,
              ...(v.plan ? { plan: v.plan } : {}),
              origin: 'app-server',
            });
          }
        }
        tools.codex = this.mapRefresh(r, this.codexCache);
      }
    } else if (cx) tools.codex = { state: 'skipped', reason: 'not-subscription' };

    this.changed();
    return { entries: await this.quotaView(), tools };
  }

  quotaHookStatus(): HookStatus {
    return hookStatus({
      root: this.d.root,
      home: this.d.home,
      env: this.d.env,
      platform: this.d.platform,
    });
  }

  /** 开启 / 关闭 Claude Code statusline 额度快照（用户在面板里主动操作） */
  setQuotaHook(enabled: boolean): HookStatus {
    const dep = {
      root: this.d.root,
      home: this.d.home,
      env: this.d.env,
      platform: this.d.platform,
      now: this.d.now,
    };
    const st = enabled ? enableHook(dep) : disableHook(dep);
    this.auth.invalidate();
    this.changed();
    return st;
  }

  private saveAlerts(): void {
    try {
      writePrivateFile(this.alertsPath, JSON.stringify(this.alertState));
    } catch (e) {
      this.d.logger.warn('usage alert state save failed', String(e));
    }
  }

  getSettings(): UsageSettings {
    return this.settings;
  }

  setSettings(patch: Partial<UsageSettings>): UsageSettings {
    const prev = this.settings;
    const merged: Partial<UsageSettings> = { ...prev, ...patch, clearedAt: prev.clearedAt };
    this.settings = sanitizeUsageSettings(merged, prev);
    const next = this.settings;
    // 切换币种：预算 / 提醒线按汇率换算，数值含义不变（没有同时改预算时）
    if (next.currency !== prev.currency) {
      const k = next.currency === 'CNY' ? next.cnyPerUsd : 1 / prev.cnyPerUsd;
      const conv = (key: 'dailyBudget' | 'monthlyBudget' | 'taskAlert') =>
        patch[key] === undefined ? Math.round(prev[key] * k * 100) / 100 : next[key];
      this.settings = {
        ...next,
        dailyBudget: conv('dailyBudget'),
        monthlyBudget: conv('monthlyBudget'),
        taskAlert: conv('taskAlert'),
      };
    }
    // 预算改了：这个周期的提醒进度重新算（调低预算后可以再次提醒）
    if (this.settings.dailyBudget !== prev.dailyBudget) this.alertState.dayLevel = 0;
    if (this.settings.monthlyBudget !== prev.monthlyBudget) this.alertState.monthLevel = 0;
    if (this.settings.taskAlert !== prev.taskAlert) this.tasks.clear();
    this.saveAlerts();
    this.save();
    if (this.settings.retention !== prev.retention) this.ledger.prune(this.settings.retention);
    if (!this.settings.enabled) {
      this.stopTimers();
      this.stopBudgetTimer();
    } else {
      this.startBudgetTimer();
      if (this.settings.readToolLogs) this.start();
      else this.stopTimers();
    }
    this.scheduleCheck();
    this.changed();
    return this.settings;
  }

  // ---------------------------------------------------------------- 采集

  /** 记一次调用（Nomi 对话 / 本地路由）。总开关关闭时直接丢弃。 */
  record(i: UsageInput): UsageRecord | null {
    if (!this.settings.enabled) return null;
    const cacheRead = Math.max(0, i.cacheRead ?? 0);
    const cacheWrite = Math.max(0, i.cacheWrite ?? 0);
    const rec: UsageRecord = {
      key: i.key ?? `${i.source}:${i.via}:${i.ts}:${++this.seq}`,
      ts: i.ts,
      ...(i.dur ? { dur: i.dur } : {}),
      source: i.source,
      via: i.via,
      ...(i.provider ? { provider: i.provider } : {}),
      model: i.model || 'unknown',
      input: Math.max(0, i.promptTokens - cacheRead - cacheWrite),
      output: Math.max(0, i.outputTokens),
      cacheRead,
      cacheWrite,
      ...(i.session ? { session: i.session } : {}),
      ...(i.project ? { project: i.project } : {}),
      ...(i.est ? { est: true } : {}),
    };
    if (!rec.input && !rec.output && !rec.cacheRead && !rec.cacheWrite) return null;
    if (!this.ledger.upsert(rec)) return null;
    this.afterRecord(rec);
    return rec;
  }

  /** 本地路由：请求开始 / 结束（结束时带上从响应里取到的 usage） */
  routeBegin(source: UsageSource): void {
    this.routeInflight.set(source, (this.routeInflight.get(source) ?? 0) + 1);
  }

  routeEnd(
    source: UsageSource,
    r: { startedAt: number; provider?: string; model: string; usage: SniffedUsage | null },
  ): void {
    this.routeInflight.set(source, Math.max(0, (this.routeInflight.get(source) ?? 1) - 1));
    if (!r.usage) return;
    const u = r.usage;
    this.record({
      ts: r.startedAt,
      dur: Math.max(0, this.now() - r.startedAt),
      source,
      via: 'route',
      provider: r.provider,
      model: u.model || r.model,
      promptTokens: u.input + u.cacheRead + u.cacheWrite,
      outputTokens: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
    });
  }

  /** 订阅新增记录（预算提醒 / 联动用） */
  onRecord(fn: (r: UsageRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private afterRecord(rec: UsageRecord): void {
    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch (e) {
        this.d.logger.warn('usage listener failed', String(e));
      }
    }
    this.trackTask(rec);
    this.scheduleCheck();
    this.changed();
  }

  // ---------------------------------------------------------------- 日志扫描

  start(): void {
    if (!this.settings.enabled) return;
    this.startBudgetTimer();
    if (this.scanTimer || !this.settings.readToolLogs) return;
    const ms = this.d.scanMs ?? 60_000;
    if (ms <= 0) return;
    // 启动后稍等一会再首扫，让出启动高峰
    const first = setTimeout(() => void this.scan(), 5_000);
    (first as { unref?: () => void }).unref?.();
    this.scanTimer = setInterval(() => void this.scan(), ms);
    (this.scanTimer as { unref?: () => void }).unref?.();
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => this.ledger.prune(this.settings.retention), 6 * 3600_000);
      (this.pruneTimer as { unref?: () => void }).unref?.();
    }
  }

  private startBudgetTimer(): void {
    if (this.budgetTimer || (this.d.scanMs ?? 60_000) <= 0) return;
    this.budgetTimer = setInterval(() => this.checkBudgets(), BUDGET_CHECK_MS);
    (this.budgetTimer as { unref?: () => void }).unref?.();
  }

  private stopBudgetTimer(): void {
    if (this.budgetTimer) clearInterval(this.budgetTimer);
    this.budgetTimer = null;
  }

  private stopTimers(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  stop(): void {
    this.stopTimers();
    this.stopBudgetTimer();
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.ledger.flush();
  }

  async scan(): Promise<{ added: number; files: number }> {
    if (!this.settings.enabled || !this.settings.readToolLogs || this.scanning)
      return { added: 0, files: 0 };
    this.scanning = true;
    try {
      const before = this.ledger.size();
      const r = await this.scanner.scan();
      this.lastScanAt = this.now();
      if (r.added || this.ledger.size() !== before) this.changed();
      return r;
    } catch (e) {
      this.d.logger.warn('usage scan failed', String(e));
      return { added: 0, files: 0 };
    } finally {
      this.scanning = false;
    }
  }

  // ---------------------------------------------------------------- 预算与提醒

  /** 记录 / 扫描后稍等一下再算（一次导入很多条也只算一次） */
  private scheduleCheck(): void {
    if (this.checkTimer || (this.d.scanMs ?? 60_000) <= 0) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      this.checkBudgets();
    }, 3000);
    (this.checkTimer as { unref?: () => void }).unref?.();
  }

  private rate(): number {
    return this.settings.currency === 'CNY' ? this.settings.cnyPerUsd : 1;
  }

  private money(usd: number): string {
    return formatMoney(usd, this.settings.currency, this.settings.cnyPerUsd);
  }

  /**
   * 日 / 月预算：达到 80% 与 100% 各提醒一次（同一周期内只升不降，跨天 / 跨月重新计）。
   * 免打扰等原因没能弹出时不记「已提醒」，下一轮（5 分钟）再试。
   */
  checkBudgets(): void {
    const s = this.settings;
    if (!s.enabled || (!(s.dailyBudget > 0) && !(s.monthlyBudget > 0))) return;
    const now = this.now();
    const d = new Date(now);
    const dayKey = dateKey(now);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (this.alertState.day !== dayKey)
      this.alertState = { ...this.alertState, day: dayKey, dayLevel: 0 };
    if (this.alertState.month !== monthKey)
      this.alertState = { ...this.alertState, month: monthKey, monthLevel: 0 };

    const todayStart = startOfDay(now);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const recs = this.ledger.range(Math.min(todayStart, monthStart), now + 1);
    const priceOf = this.priceOf();
    let day = 0;
    let month = 0;
    let unpriced = false;
    for (const r of recs) {
      const c = recordCost(r, priceOf);
      if (c === null) {
        unpriced = true;
        continue;
      }
      month += c;
      if (r.ts >= todayStart) day += c;
    }
    const k = this.rate();
    const level = (cost: number, budget: number): 0 | 80 | 100 => {
      if (!(budget > 0)) return 0;
      const ratio = (cost * k) / budget;
      return ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : 0;
    };
    const dl = level(day, s.dailyBudget);
    const ml = level(month, s.monthlyBudget);
    const fire: Array<{ scope: 'day' | 'month'; level: 80 | 100; text: string }> = [];
    const text = (period: string, cost: number, budget: number, lv: 80 | 100) =>
      lv === 100
        ? tr(
            '{0}的花费已超过预算（{1} / {2}）。',
            period,
            this.money(cost),
            formatAmount(budget, s.currency),
          )
        : tr(
            '{0}的花费已用到预算的 80%（{1} / {2}）。',
            period,
            this.money(cost),
            formatAmount(budget, s.currency),
          );
    if (dl > this.alertState.dayLevel && dl > 0)
      fire.push({
        scope: 'day',
        level: dl as 80 | 100,
        text: text(tr('今天'), day, s.dailyBudget, dl as 80 | 100),
      });
    if (ml > this.alertState.monthLevel && ml > 0)
      fire.push({
        scope: 'month',
        level: ml as 80 | 100,
        text: text(tr('本月'), month, s.monthlyBudget, ml as 80 | 100),
      });
    if (!fire.length) return;
    const top = fire.some((f) => f.level === 100) ? 100 : 80;
    const body = fire.map((f) => f.text).join(' ') + (unpriced ? tr('（未定价模型不计入）') : '');
    const delivered = this.d.alert?.({
      kind: top === 100 ? 'budget-100' : 'budget-80',
      title: tr('用量预算提醒'),
      text: body,
    });
    if (!delivered) return;
    for (const f of fire) {
      if (f.scope === 'day') this.alertState.dayLevel = f.level;
      else this.alertState.monthLevel = f.level;
    }
    this.saveAlerts();
    this.d.logger.info('usage budget alert', { levels: fire.map((f) => `${f.scope}:${f.level}`) });
  }

  /**
   * 单任务高花费：同一个会话里连续使用（间隔 < 10 分钟）算一个任务，
   * 已定价部分的花费超过「提醒线」就提醒一次。
   */
  private trackTask(rec: UsageRecord): void {
    const s = this.settings;
    if (!s.enabled || !(s.taskAlert > 0) || !rec.key) return;
    const now = this.now();
    if (rec.ts < now - TASK_FRESH_MS) return;
    const cost = recordCost(rec, this.priceOf());
    if (cost === null) return;
    const key = rec.session ? `${rec.source}:${rec.session}` : `${rec.source}:${rec.via}`;
    let t = this.tasks.get(key);
    if (!t || rec.ts - t.last > TASK_GAP_MS) {
      t = { last: rec.ts, parts: new Map(), alerted: false };
      this.tasks.set(key, t);
    }
    t.last = Math.max(t.last, rec.ts);
    t.parts.set(rec.key, cost); // 同一条消息的后续分段会更新同一个键，不重复累计
    for (const [k, v] of this.tasks) if (now - v.last > 2 * TASK_GAP_MS) this.tasks.delete(k);
    if (t.alerted) return;
    let total = 0;
    for (const v of t.parts.values()) total += v;
    if (total * this.rate() < s.taskAlert) return;
    const label = SOURCE_LABEL[rec.source] ?? rec.source;
    const who = rec.project ? `${label}（${rec.project}）` : label;
    const delivered = this.d.alert?.({
      kind: 'task',
      title: tr('单次任务花费偏高'),
      text: tr(
        '{0} 这次任务已经花了约 {1}（提醒线 {2}），要不要看一眼？',
        who,
        this.money(total),
        formatAmount(s.taskAlert, s.currency),
      ),
    });
    if (delivered) t.alerted = true;
  }

  // ---------------------------------------------------------------- 会话 / 任务累计

  private sessionMap(): Map<string, SessionUsage> {
    const ver = this.ledger.version();
    const prices = this.settings.customPrices;
    const priceVer = this.priceSync.version();
    if (
      this.sessionCache &&
      this.sessionCache.ver === ver &&
      this.sessionCache.prices === prices &&
      this.sessionCache.priceVer === priceVer
    )
      return this.sessionCache.map;
    const priceOf = this.priceOf();
    const map = new Map<string, SessionUsage>();
    for (const r of this.ledger.all()) {
      if (!r.session) continue;
      const key = `${r.source}:${r.session}`;
      const e = map.get(key) ?? { tokens: 0, costUsd: null, calls: 0, unpriced: false };
      accumulate(e, r, priceOf);
      map.set(key, e);
    }
    this.sessionCache = { ver, prices, priceVer, map };
    return map;
  }

  /** 某个编程工具会话的累计用量（CodingMonitor 显示用） */
  sessionUsage(source: UsageSource, session: string): SessionUsage | null {
    if (!this.settings.enabled) return null;
    return this.sessionMap().get(`${source}:${session}`) ?? null;
  }

  /** 某来源从 since 起的用量；给了 session 时只算该会话（以及尚未归属会话的路由记录） */
  costSince(q: { source: UsageSource; since: number; session?: string }): SessionUsage | null {
    if (!this.settings.enabled) return null;
    const priceOf = this.priceOf();
    const e: SessionUsage = { tokens: 0, costUsd: null, calls: 0, unpriced: false };
    for (const r of this.ledger.range(q.since, this.now() + 1)) {
      if (r.source !== q.source) continue;
      if (q.session && r.session !== q.session && !(r.via === 'route' && !r.session)) continue;
      accumulate(e, r, priceOf);
    }
    return e.calls ? e : null;
  }

  /** 任务结束播报里附带的一句话：「本次约用 1.2M Token，花费约 $0.42。」没有可报的就返回 null */
  taskCostLine(q: { source: UsageSource; since: number; session?: string }): string | null {
    const u = this.costSince(q);
    if (!u || u.tokens <= 0) return null;
    const tokens = formatTokens(u.tokens);
    if (u.costUsd === null) return tr('本次约用 {0} Token（模型未定价，费用未计）。', tokens);
    const cost = this.money(u.costUsd);
    return u.unpriced
      ? tr('本次约用 {0} Token，已计价部分约 {1}。', tokens, cost)
      : tr('本次约用 {0} Token，花费约 {1}。', tokens, cost);
  }

  // ---------------------------------------------------------------- 查询

  private priceOf() {
    return makePriceOf(this.settings.customPrices, this.priceSync.entries());
  }

  private labels(): Labels {
    return { providerName: (id) => this.d.providerName?.(id) };
  }

  state() {
    return {
      settings: this.settings,
      detected: this.scanner.detected(),
      records: this.ledger.size(),
      lastScanAt: this.lastScanAt,
      pricing: {
        date: PRICING_TABLE_DATE,
        builtin: BUILTIN_PRICES.map((p) => ({ ...p })),
        sync: this.priceSync.state(),
      },
    };
  }

  /**
   * 手动同步价格（用户点「同步价格」才会走到这里）：只下载 models.dev 的公开价格表，不上传任何用量。
   * 返回结果 + 最新状态；成功后通知各窗口刷新。
   */
  async syncPrices(): Promise<{ result: PriceSyncResult } & ReturnType<UsageService['state']>> {
    const result = await this.priceSync.sync();
    if (result.ok) this.changed();
    return { result, ...this.state() };
  }

  query(rangeId: RangeId) {
    const now = this.now();
    const range = rangeOf(rangeId, now);
    const priceOf = this.priceOf();
    // 一次取「上一周期起点 → 现在」，再切两段
    const recs = this.ledger.range(range.prevFrom, range.to);
    const cur = recs.filter((r) => r.ts >= range.from);
    const prev = recs.filter((r) => r.ts < range.from);
    return {
      range: { id: range.id, from: range.from, to: range.to, bucket: range.bucket },
      summary: summarize(cur, priceOf),
      prev: summarize(prev, priceOf),
      series: series(cur, range, priceOf),
      bySource: breakdown(cur, 'source', priceOf, this.labels()),
      byProvider: breakdown(cur, 'provider', priceOf, this.labels()),
      byModel: breakdown(cur, 'model', priceOf, this.labels()),
    };
  }

  heatmap() {
    const now = this.now();
    const days = heatmap(this.ledger.all(), now, this.priceOf());
    return { days, today: dateKey(now) };
  }

  details(q: DetailQuery) {
    return details(this.ledger.all(), q, this.priceOf(), this.labels());
  }

  csv(q: DetailQuery): string {
    const recs = this.ledger
      .all()
      .filter(
        (r) =>
          r.ts >= q.from &&
          r.ts < q.to &&
          (!q.source || r.source === q.source) &&
          (!q.model || r.model === q.model) &&
          (!q.session || r.session === q.session),
      );
    const rows = recs.map((r) => toRow(r, this.priceOf(), this.labels()));
    rows.sort((a, b) => b.ts - a.ts);
    return toCsv(rows, this.settings.currency, this.settings.cnyPerUsd);
  }

  clear(): void {
    this.settings = { ...this.settings, clearedAt: this.now() };
    this.save();
    this.ledger.clear();
    this.codexQuota = null;
    this.codexFp = null;
    this.claudeFp = null;
    this.quotaFloor = 0;
    this.codexCache.clear();
    this.claudeCache.clear();
    try {
      fs.rmSync(this.quotaPath, { force: true });
      fs.rmSync(path.join(this.d.root, SNAPSHOT_FILE), { force: true });
    } catch {
      /* 忽略 */
    }
    this.changed();
  }

  // ---------------------------------------------------------------- IPC

  private changed(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        w.webContents.send('ai:usage:changed', null);
      }
    }, 1500);
    (this.broadcastTimer as { unref?: () => void }).unref?.();
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown | Promise<unknown>) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (e, ...a) => {
        try {
          const url = (e as { sender?: { getURL?: () => string } }).sender?.getURL?.();
          if (!isTrustedSenderUrl(url)) throw new Error('untrusted sender');
          return await fn(...a);
        } catch (err) {
          return { __error: { message: err instanceof Error ? err.message : String(err) } };
        }
      });
    };
    const rid = (v: unknown): RangeId =>
      v === 'today' || v === '7d' || v === '30d' || v === '90d' ? v : '7d';
    const dq = (v: unknown): DetailQuery => {
      const o = (v && typeof v === 'object' ? v : {}) as Partial<DetailQuery>;
      const now = this.now();
      const s = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
      return {
        from: typeof o.from === 'number' ? o.from : rangeOf('90d', now).from,
        to: typeof o.to === 'number' ? o.to : rangeOf('today', now).to,
        source: s(o.source),
        model: s(o.model),
        session: s(o.session),
        sort: o.sort,
        dir: o.dir === 'asc' ? 'asc' : 'desc',
        limit: typeof o.limit === 'number' ? o.limit : 100,
        offset: typeof o.offset === 'number' ? o.offset : 0,
      };
    };
    handle('ai:usage:state', () => this.state());
    handle('ai:usage:query', (r) => this.query(rid(r)));
    handle('ai:usage:heatmap', () => this.heatmap());
    handle('ai:usage:details', (q) => this.details(dq(q)));
    handle('ai:usage:csv', (q) => this.csv(dq(q)));
    handle('ai:usage:set-settings', (p) => this.setSettings((p ?? {}) as Partial<UsageSettings>));
    handle('ai:usage:quota', () => this.quotaView());
    handle('ai:usage:quota-refresh', () => this.refreshQuota());
    handle('ai:usage:quota-hook', () => this.quotaHookStatus());
    handle('ai:usage:quota-hook-set', (v) => this.setQuotaHook(v === true));
    handle('ai:usage:price-sync', () => this.syncPrices());
    handle('ai:usage:scan', async () => {
      const r = await this.scan();
      return { ...r, ...this.state() };
    });
    handle('ai:usage:clear', () => {
      this.clear();
      return this.state();
    });
  }
}

let inst: UsageService | null = null;
export function initUsageService(d: Deps): UsageService {
  inst?.stop();
  inst = new UsageService(d);
  return inst;
}
export function getUsageService(): UsageService | null {
  return inst;
}
