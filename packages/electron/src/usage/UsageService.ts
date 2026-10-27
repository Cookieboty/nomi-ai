/**
 * 用量与计费服务（主进程）：
 * - 采集：Nomi 对话（响应 usage，没有才估算并标「估算」）/ 本地路由经过的请求 / 编程工具会话日志；
 * - 存储：userData/usage/ledger.jsonl（只在本机，不上传）；设置 userData/usage/settings.json；
 * - 查询：汇总 / 趋势 / 分布 / 排行 / 热力图 / 明细 / CSV，费用按 USD 算、界面换算币种；
 * - 隐私：总开关、是否读取编程工具日志、保留时长、一键清空。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
import { BrowserWindow } from 'electron';

import { officialAccountEnv } from '../cli/accounts/homes';
import { withCliPath } from '../cli/detect';
import { t as tr } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { writePrivateFile } from '../utils/privateFile';

import {
  addDays,
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
import {
  AuthModeDetector,
  applyAuthModes,
  type AuthDeps,
  type AuthInfo,
  type AuthMode,
} from './authMode';
import {
  disableHook,
  enableHook,
  hookStatus,
  readStatuslineSnapshot,
  SNAPSHOT_FILE,
  type HookStatus,
} from './claudeStatusline';
import { ClaudeUsageFetcher, claudeUsageEnv, type ClaudeFetcherDeps } from './claudeSubscription';
import { CodexRateLimitReader, type CodexRpcDeps } from './codexRateLimits';
import { GrokBillingFetcher, type GrokBillingDeps } from './grokSubscription';
import { formatAmount, formatMoney, formatTokens } from './money';
import { PriceSync, type PriceSyncResult } from './priceSync';
import {
  BUILTIN_PRICES,
  costUsd,
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
import { fingerprint, loadSalt } from './quotaIdentity';
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
  /** 启动时自动同步模型数据（价格 + 模型参数，models.dev）；距上次核对不足 12 小时不同步 */
  modelsSyncAuto: boolean;
}

/** 启动时自动同步模型数据的最短间隔 */
export const MODELS_SYNC_INTERVAL_MS = 12 * 60 * 60_000;

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
  modelsSyncAuto: true,
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
    modelsSyncAuto: b(o.modelsSyncAuto, base.modelsSyncAuto),
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
  /** 账本同步载入的大小上限（字节，见 UsageLedger）；测试传 0 让非空账本走后台载入 */
  ledgerSyncLoadMaxBytes?: number;
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
  grokBilling?: GrokBillingDeps;
  /**
   * 当前 Grok 登录的账号标识（由账号模块给出，来自 CLI 自己报告的身份；Nomi 不读 auth.json，§5.10 S7）。
   * 只在内存里用来算加盐指纹，判断恢复 / 刷新的额度是不是同一个账号的。
   */
  grokAccountKey?: () => string | null;
  /**
   * 某个工具的默认官方账号（§5.10）：额度、登录方式都跟着默认账号的账号目录走。
   * prepare = 接下来要启动官方 CLI（先补齐账号目录）。dir 为 null 是用户自己的 CLI 目录。
   */
  officialAccount?: (
    kind: QuotaToolId,
    prepare: boolean,
  ) => { dir: string | null; args: string[] } | null;
  /** 价格同步所用的 fetch（测试注入；默认全局 fetch，只在用户点「同步价格」时调用） */
  priceFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** 模型数据同步下载到新数据时交给网关生成模型目录；网关还没有目录缓存时强制完整下载 */
  onModelsData?: (api: unknown) => void;
  needsFullModelsData?: () => boolean;
};

/** 单个工具这次「刷新」的结果（面板提示用，不含任何账号信息） */
export type ToolRefresh =
  | { state: 'fresh-local' }
  | { state: 'ok' }
  | { state: 'throttled'; retryInSec: number }
  | { state: 'transient'; reason: string; stale: boolean }
  | { state: 'auth'; reason: string }
  | { state: 'skipped'; reason: 'disabled' | 'not-subscription' };

/**
 * 有订阅额度卡的编程助手：插件清单里声明了 capabilities.usageQuota 的内置 CLI
 * （tests/unit/usage/quotaTools.test.ts 核对两者一致）。
 */
export type QuotaToolId = Extract<BuiltinCliId, 'claude' | 'codex' | 'grok'>;
export const QUOTA_TOOL_IDS: readonly QuotaToolId[] = ['claude', 'codex', 'grok'];

export interface QuotaRefreshReport {
  entries: QuotaEntry[];
  tools: Partial<Record<'claude' | 'codex' | 'grok', ToolRefresh>>;
}

/** 本机已有的额度快照多久算「还新」：更新鲜就不拉起官方 CLI */
export const QUOTA_FRESH_MS = 5 * 60_000;
/** 自动刷新：同一工具至少隔这么久才在后台拉起一次官方 CLI（手动刷新仍是 60 秒节流） */
export const QUOTA_AUTO_MS = 30 * 60_000;
/** 面板最近这么久内读过额度才算「额度卡可见」 */
const QUOTA_VIEW_WINDOW_MS = 2 * 60_000;
/** 最近这么久内用过该工具才自动刷新它的额度 */
const QUOTA_AUTO_ACTIVE_MS = 24 * 3600_000;
const QUOTA_AUTO_CHECK_MS = 5 * 60_000;

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
  /** 缓存写里的 1 小时档（≤ cacheWrite）；缺省 = 全部按 5 分钟档 */
  cacheWrite1h?: number;
  /** Anthropic 快速模式（usage.speed === 'fast'） */
  fast?: boolean;
  est?: boolean;
  session?: string;
  project?: string;
  /** 去重键；不传则按来源 + 时间 + token 生成 */
  key?: string;
  /** 路由：上游响应 / 消息 id */
  rid?: string;
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

/** quota.json 里的登录方式结论：只认订阅 / API 两种模式与 16 位十六进制指纹 */
function savedAuthModes(v: unknown): Record<string, AuthInfo> {
  const out: Record<string, AuthInfo> = {};
  if (!v || typeof v !== 'object') return out;
  for (const id of ['claude', 'codex', 'grok']) {
    const r = (v as Record<string, unknown>)[id] as Partial<AuthInfo> | undefined;
    if (!r || (r.mode !== 'subscription' && r.mode !== 'api')) continue;
    out[id] = {
      mode: r.mode,
      fp: typeof r.fp === 'string' && /^[0-9a-f]{16}$/.test(r.fp) ? r.fp : null,
      ...(typeof r.plan === 'string' ? { plan: r.plan.slice(0, 64) } : {}),
    };
  }
  return out;
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
  private quotaAutoTimer: ReturnType<typeof setInterval> | null = null;
  private lastQuotaView = 0;
  private readonly quotaAutoAt = new Map<QuotaToolId, number>();
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
  private readonly grokFetcher: GrokBillingFetcher;
  private readonly grokCache: IdentityQuotaCache;
  /** 一键清空计数：刷新开始时捕获，返回时对不上 = 期间被清空，结果不再落盘 */
  private quotaEpoch = 0;
  private refreshing: Promise<QuotaRefreshReport> | null = null;
  private readonly toolRefreshing = new Map<QuotaToolId, Promise<QuotaRefreshReport>>();
  private readonly toolCore = new Map<QuotaToolId, Promise<ToolRefresh | undefined>>();
  private scanShared: Promise<void> | null = null;
  readonly quotaSources = new QuotaRegistry();
  private readonly auth: AuthModeDetector;
  /** quota.json 里上一次官方登录状态的结论，构造完探测器后交给它 */
  private savedAuth: Record<string, AuthInfo> = {};
  private sessionCache: {
    ver: number;
    prices: unknown;
    priceVer: number;
    map: Map<string, SessionUsage>;
  } | null = null;
  /** 热力图缓存：账本 / 价格 / 日期都没变时直接复用（界面每次 ai:usage:changed 都会重查） */
  private heatCache: {
    ver: number;
    prices: unknown;
    priceVer: number;
    today: number;
    days: ReturnType<typeof heatmap>;
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
      ...(d.onModelsData ? { onData: d.onModelsData } : {}),
      ...(d.needsFullModelsData ? { needsFull: d.needsFullModelsData } : {}),
    });
    this.load();
    this.loadAlerts();
    this.salt = loadSalt(d.root);
    this.claudeCache = new IdentityQuotaCache(() => this.now());
    this.codexCache = new IdentityQuotaCache(() => this.now());
    this.grokCache = new IdentityQuotaCache(() => this.now());
    this.loadQuota();
    // 恢复完之后再挂：Claude / Grok 的额度一变就落盘，下次打开直接显示上一次的值
    this.claudeCache.setOnChange(() => this.saveQuota());
    this.grokCache.setOnChange(() => this.saveQuota());
    this.claudeFetcher = new ClaudeUsageFetcher({
      now: d.now,
      env: () => claudeUsageEnv(this.accountLaunch('claude').env),
      ...d.claudeUsage,
    });
    this.codexReader = new CodexRateLimitReader({
      now: d.now,
      salt: () => this.salt,
      env: () => this.accountLaunch('codex').env,
      extraArgs: () => this.accountLaunch('codex').args,
      ...d.codexRpc,
    });
    this.grokFetcher = new GrokBillingFetcher({
      now: d.now,
      env: () => this.accountLaunch('grok').env,
      ...d.grokBilling,
    });
    this.auth = new AuthModeDetector({
      home: d.home,
      env: d.env,
      envFor: (id) => (this.d.officialAccount ? this.accountEnv(id, false) : null),
      now: d.now,
      run: d.authRun,
      salt: () => this.salt,
      // 日志 / 快照里已经有带额度的数据，说明是订阅登录
      hasSubscriptionData: (id) =>
        id === 'codex'
          ? !!this.codexQuota?.plan
          : id === 'claude'
            ? !!readStatuslineSnapshot(d.root)
            : id === 'grok'
              ? !!this.grokCache.get()?.windows.length
              : false,
    });
    this.auth.restoreKnown(this.savedAuth);
    this.auth.setOnKnownChange(() => this.saveQuota());
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
    this.quotaSources.register({
      id: 'grok',
      label: 'Grok',
      read: () => {
        if (!this.settings.enabled) return null;
        return this.grokCache.get();
      },
    });
    this.ledger = new UsageLedger({
      root: d.root,
      logger: d.logger,
      now: d.now,
      onPersistChange: () => this.changed(),
      ...(d.ledgerSyncLoadMaxBytes !== undefined
        ? { syncLoadMaxBytes: d.ledgerSyncLoadMaxBytes }
        : {}),
      // 大账本后台载入完成：通知界面重查，预算按完整数据再算一次
      onLoaded: () => {
        this.changed();
        this.scheduleCheck();
      },
    });
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
        claude?: unknown;
        grok?: unknown;
        grokFp?: unknown;
        auth?: unknown;
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
      // Claude（`/usage` 读到的值）与 Grok：同一账号才恢复；早于「清空」水位的不恢复
      const claude = this.savedReading(o.claude);
      if (claude) this.claudeCache.restore(this.claudeFp, claude);
      // Grok：保存时的账号指纹必须与当前登录一致才恢复；对不上（换号 / 登出 / 旧版本没存指纹）就丢弃
      const grok = this.savedReading(o.grok);
      const savedGrokFp = fp(o.grokFp);
      if (grok && savedGrokFp && savedGrokFp === this.currentGrokFp())
        this.grokCache.restore(savedGrokFp, grok);
      this.savedAuth = savedAuthModes(o.auth);
    } catch {
      /* 没有快照 */
    }
  }

  /**
   * 在 Nomi「官方账号」里切换了某个 CLI 的账号：清掉上一个账号的额度（内存与落盘），
   * 不能把旧账号的数字显示给新账号。凭据由账号模块处理，这里只收到通知。
   */
  forgetAccountQuota(kind: string): void {
    // 换了号：上一次登录状态里的账号指纹 / 套餐也作废
    if (kind === 'claude' || kind === 'codex' || kind === 'grok') this.auth.forgetKnown(kind);
    if (kind === 'claude') {
      this.dropClaudeQuota();
      this.claudeFp = null;
    } else if (kind === 'codex') {
      this.codexFp = null;
      this.codexCache.clear();
      this.dropCodexQuota();
    } else if (kind === 'grok') {
      this.grokCache.clear();
    } else return;
    this.saveQuota();
    this.changed();
  }

  /** 默认官方账号的进程环境（账号目录变量已设好，§5.10）；prepare = 要启动 CLI，先补齐账号目录 */
  private accountEnv(kind: QuotaToolId, prepare: boolean): NodeJS.ProcessEnv {
    return this.officialAccountOf(kind, prepare).env;
  }

  /** 启动官方 CLI 取额度用：环境 + 账号目录追加的参数 */
  private accountLaunch(kind: QuotaToolId): { env: NodeJS.ProcessEnv; args: string[] } {
    return this.officialAccountOf(kind, true);
  }

  private officialAccountOf(
    kind: QuotaToolId,
    prepare: boolean,
  ): { env: NodeJS.ProcessEnv; args: string[] } {
    const base = withCliPath(this.d.env ?? process.env);
    let a: { dir: string | null; args: string[] } | null;
    try {
      a = this.d.officialAccount?.(kind, prepare) ?? null;
    } catch {
      a = null;
    }
    return a
      ? { env: officialAccountEnv(kind, base, a.dir), args: a.args }
      : { env: base, args: [] };
  }

  /** 当前 Grok 登录的加盐指纹（没登录 / 读不出 = null） */
  private currentGrokFp(): string | null {
    let key: string | null;
    try {
      key = this.d.grokAccountKey ? this.d.grokAccountKey() : null;
    } catch {
      key = null;
    }
    return key ? fingerprint(this.salt, ['grok', key]) : null;
  }

  private savedReading(v: unknown): QuotaReading | null {
    const r = v as Partial<QuotaReading> | null;
    if (!r || typeof r.updatedAt !== 'number' || !Array.isArray(r.windows)) return null;
    if (r.updatedAt < this.quotaFloor) return null;
    const windows = sanitizeWindows(r.windows, 0);
    if (!windows.length) return null;
    return {
      windows,
      updatedAt: r.updatedAt,
      ...(typeof r.plan === 'string' ? { plan: r.plan } : {}),
      ...(typeof r.origin === 'string' ? { origin: r.origin } : {}),
    };
  }

  private saveQuota(): void {
    // 构造期间（登录方式探测器还没建好）沿用刚读到的值
    const auth = this.auth as AuthModeDetector | undefined;
    const authKnown = auth ? auth.knownSnapshot() : this.savedAuth;
    try {
      writePrivateFile(
        this.quotaPath,
        JSON.stringify({
          ...(this.codexQuota ? { codex: this.codexQuota } : {}),
          ...(this.codexFp ? { codexFp: this.codexFp } : {}),
          ...(this.claudeFp ? { claudeFp: this.claudeFp } : {}),
          ...(this.quotaFloor ? { floor: this.quotaFloor } : {}),
          ...(this.claudeCache.snapshot() ? { claude: this.claudeCache.snapshot()!.value } : {}),
          ...(authKnown && Object.keys(authKnown).length ? { auth: authKnown } : {}),
          ...(this.grokCache.snapshot()
            ? {
                grok: this.grokCache.snapshot()!.value,
                ...(this.grokCache.snapshot()!.identity
                  ? { grokFp: this.grokCache.snapshot()!.identity }
                  : {}),
              }
            : {}),
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
    return this.quotaEntries();
  }

  /** 面板读额度（额度卡可见）：记下时间，后台自动刷新只在卡片可见时进行 */
  private quotaViewed(): Promise<QuotaEntry[]> {
    this.lastQuotaView = this.now();
    return this.quotaEntries();
  }

  /**
   * 后台自动刷新（「先读 CLI 已有数据，读不到再低频请求一次」）：总开关 + 主动刷新开、额度卡可见、
   * 最近 24 小时用过该工具、是订阅登录时，同一工具至少隔 30 分钟才拉起一次官方 CLI；
   * 本机快照 / 缓存还新时 refresh 自己会直接返回，不起进程。
   */
  async autoRefreshQuota(): Promise<void> {
    if (!(this.settings.enabled && this.settings.activeQuotaRefresh)) return;
    await this.ledger.whenReady();
    const now = this.now();
    if (now - this.lastQuotaView > QUOTA_VIEW_WINDOW_MS) return;
    const due = (['claude', 'codex', 'grok'] as const).filter((tool) => {
      if (now - (this.quotaAutoAt.get(tool) ?? -Infinity) < QUOTA_AUTO_MS) return false;
      const last = this.ledger.lastTs(tool);
      if (last == null || now - last > QUOTA_AUTO_ACTIVE_MS) return false;
      return this.auth.detectPassive(tool).mode === 'subscription';
    });
    if (!due.length) return;
    for (const tool of due) this.quotaAutoAt.set(tool, now);
    await Promise.all(due.map((tool) => this.runToolRefresh(tool).catch(() => undefined)));
    this.changed();
  }

  private async quotaEntries(): Promise<QuotaEntry[]> {
    const modes: Record<string, AuthMode> = {};
    // 被动读取：只用缓存 / 本地配置 / 已有额度数据，绝不启动官方 CLI 的登录探测进程
    for (const id of ['claude', 'codex', 'dsh', 'grok', 'nomi']) {
      const info = this.auth.detectPassive(id);
      modes[id] = info.mode;
      // 本地信号显示已退出登录：清掉上一个账号的额度（只删数据，不起进程；没有旧数据时不重复清）
      if (id === 'claude' && info.signedOut) {
        if (this.claudeFp || this.claudeCache.get() || readStatuslineSnapshot(this.d.root))
          this.applySignedOut('claude');
        continue;
      }
      if (id === 'claude') this.observeClaudeIdentity(info.fp);
    }
    return applyAuthModes(this.quota(), modes, new Set(this.scanner.detected()));
  }

  /**
   * 用户点「刷新」：先重读本机已有的数据（会话日志）；快照缺失 / 过期 / 超过 5 分钟才会拉起官方 CLI：
   * - Claude Code：`claude -p /usage --output-format json`；
   * - Codex：`codex app-server` 的 `account/rateLimits/read`；
   * - Grok：官方 CLI ACP 的 `_x.ai/billing` 扩展。
   * 三者都是官方 CLI 用自己的登录态去取，Nomi 不接触凭据；每个来源 60 秒内最多真实拉取一次；
   * 「主动刷新额度」关闭时一律不拉起 CLI。后台另有低频自动刷新（autoRefreshQuota，每工具至少 30 分钟一次）。
   * 都在默认官方账号的账号目录里运行（§5.10）。
   */
  refreshQuota(tool?: QuotaToolId): Promise<QuotaRefreshReport> {
    if (tool) return this.refreshQuotaTool(tool);
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

  /**
   * 单个工具刷新（卡片自己的刷新按钮）：只拉起这一个工具的官方 CLI，
   * 同一工具并发点击合并；不同工具之间互不等待、互不阻塞。
   */
  private refreshQuotaTool(tool: QuotaToolId): Promise<QuotaRefreshReport> {
    const hit = this.toolRefreshing.get(tool);
    if (hit) return hit;
    const p = this.doRefreshTool(tool);
    this.toolRefreshing.set(tool, p);
    void p
      .finally(() => {
        if (this.toolRefreshing.get(tool) === p) this.toolRefreshing.delete(tool);
      })
      .catch(() => undefined);
    return p;
  }

  private async doRefreshTool(tool: QuotaToolId): Promise<QuotaRefreshReport> {
    const res = await this.runToolRefresh(tool);
    this.changed();
    return { entries: await this.quotaView(), tools: res ? { [tool]: res } : {} };
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
      case 'superseded': // 拉取期间被清空 / 换号：结果已丢弃，让用户稍后再刷新
        return { state: 'transient', reason: 'superseded', stale: false };
      case 'transient':
        return { state: 'transient', reason: r.reason, stale: r.stale };
      default:
        return { state: 'auth', reason: r.reason };
    }
  }

  private async doRefreshQuota(): Promise<QuotaRefreshReport> {
    // 三个工具并行：各自的官方 CLI 互不等待（单个超时不拖慢其他工具）
    const ids: QuotaToolId[] = ['claude', 'codex', 'grok'];
    const results = await Promise.all(ids.map((id) => this.runToolRefresh(id)));
    const tools: QuotaRefreshReport['tools'] = {};
    ids.forEach((id, i) => {
      const r = results[i];
      if (r) tools[id] = r;
    });
    this.changed();
    return { entries: await this.quotaView(), tools };
  }

  /** 同一工具的刷新合并成一次；和「全部刷新」共用，避免重复拉起 CLI */
  private runToolRefresh(tool: QuotaToolId): Promise<ToolRefresh | undefined> {
    const hit = this.toolCore.get(tool);
    if (hit) return hit;
    const p = this.coreToolRefresh(tool);
    this.toolCore.set(tool, p);
    void p
      .finally(() => {
        if (this.toolCore.get(tool) === p) this.toolCore.delete(tool);
      })
      .catch(() => undefined);
    return p;
  }

  private async coreToolRefresh(tool: QuotaToolId): Promise<ToolRefresh | undefined> {
    await this.scanForRefresh();
    // 只有「总开关开 + 主动刷新开 + 用户点了这个工具」才授权启动该工具的登录状态探测进程
    const active = this.settings.enabled && this.settings.activeQuotaRefresh;
    if (active) this.auth.invalidate(tool);
    return tool === 'claude'
      ? this.refreshClaude(active)
      : tool === 'codex'
        ? this.refreshCodex(active)
        : this.refreshGrok(active);
  }

  /** 刷新前先重读一遍本机日志；并发的刷新共用同一次扫描 */
  private scanForRefresh(): Promise<void> {
    if (!(this.settings.enabled && this.settings.readToolLogs)) return Promise.resolve();
    if (!this.scanShared) {
      const p = this.scan()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          if (this.scanShared === p) this.scanShared = null;
        });
      this.scanShared = p;
    }
    return this.scanShared;
  }

  /** 官方 CLI 明确说已退出登录：立即清掉该工具上一个账号的额度、快照和防回流水位 */
  private applySignedOut(tool: 'claude' | 'codex'): ToolRefresh {
    if (tool === 'claude') {
      this.dropClaudeQuota();
      if (this.claudeFp) {
        this.claudeFp = null;
        this.saveQuota();
      }
    } else {
      this.codexFp = null;
      this.codexCache.clear();
      this.dropCodexQuota();
    }
    return { state: 'auth', reason: 'not-signed-in' };
  }

  /** 关闭主动刷新 / 总开关时的结果：不探测，只依据已知（缓存 / 配置 / 已有数据 / 本机是否装了该工具） */
  private inactiveRefresh(tool: QuotaToolId, mode: AuthMode): ToolRefresh | undefined {
    if (mode === 'api') return { state: 'skipped', reason: 'not-subscription' };
    if (mode === 'subscription' || this.scanner.detected().includes(tool))
      return { state: 'skipped', reason: 'disabled' };
    return undefined;
  }

  private async refreshClaude(active: boolean): Promise<ToolRefresh | undefined> {
    if (!active) {
      const cl = this.auth.detectPassive('claude');
      this.observeClaudeIdentity(cl.fp);
      return this.inactiveRefresh('claude', cl.mode);
    }
    const cl = await this.auth.detectFull('claude').catch(() => null);
    if (cl?.signedOut) return this.applySignedOut('claude');
    if (cl) this.observeClaudeIdentity(cl.fp);
    if (cl?.mode === 'subscription') {
      const snap = readStatuslineSnapshot(this.d.root);
      if (this.fresh(snap) || this.fresh(this.claudeCache.get())) return { state: 'fresh-local' };
      const epoch = this.quotaEpoch;
      const r = await this.claudeCache.refresh(cl.fp, () => this.claudeFetcher.fetch(cl.plan));
      if (r.state === 'auth' && epoch === this.quotaEpoch) this.dropClaudeQuota();
      return this.mapRefresh(r, this.claudeCache);
    } else if (cl) return { state: 'skipped', reason: 'not-subscription' };
    return undefined;
  }

  private async refreshCodex(active: boolean): Promise<ToolRefresh | undefined> {
    if (!active) return this.inactiveRefresh('codex', this.auth.detectPassive('codex').mode);
    const cx = await this.auth.detectFull('codex').catch(() => null);
    if (cx?.signedOut) return this.applySignedOut('codex');
    if (cx?.mode === 'subscription') {
      if (this.codexQuota && this.fresh({ ...this.codexQuota, updatedAt: this.codexQuota.ts }))
        return { state: 'fresh-local' };
      const epoch = this.quotaEpoch;
      const r = await this.codexCache.refresh(null, () => this.codexReader.fetch());
      // 拉取期间用户清空过 / 换过号：旧结果不能再落盘（连已删除的 quota.json 都不能重建）
      if (r.state === 'superseded' || epoch !== this.quotaEpoch)
        return this.mapRefresh(
          r.state === 'superseded' ? r : { state: 'superseded' },
          this.codexCache,
        );
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
      return this.mapRefresh(r, this.codexCache);
    } else if (cx) return { state: 'skipped', reason: 'not-subscription' };
    return undefined;
  }

  private async refreshGrok(active: boolean): Promise<ToolRefresh | undefined> {
    if (!active) return this.inactiveRefresh('grok', this.auth.detectPassive('grok').mode);
    const gx = await this.auth.detectFull('grok').catch(() => null);
    if (gx?.mode === 'subscription') {
      if (this.fresh(this.grokCache.get())) return { state: 'fresh-local' };
      // 带上当前账号指纹：会话中途换了号也会先清掉旧账号的值
      const r = await this.grokCache.refresh(this.currentGrokFp(), () => this.grokFetcher.fetch());
      return this.mapRefresh(r, this.grokCache);
    } else if (gx) return { state: 'skipped', reason: 'not-subscription' };
    return undefined;
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
    // 计价分档：缓存写里的 1 小时档（不超过缓存写总量）、快速模式（缺省 = 旧口径）
    const w1h = Math.min(Math.max(0, i.cacheWrite1h ?? 0), cacheWrite);
    if (w1h) rec.cacheWrite1h = w1h;
    if (i.fast) rec.fast = true;
    if (i.rid) rec.rid = i.rid;
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
      // 有上游响应 id 就用它当稳定键：Claude 原生 msg_… 与工具日志的键相同 → 同一次请求自然合并为一条；
      // 其它 id 带 route: 前缀，日志侧按 id 后缀精确联结。没有 id 才退回按时间窗口 + 一对一匹配。
      ...(u.id
        ? {
            key:
              source === 'claude' && u.id.startsWith('msg_')
                ? `claude:${u.id}`
                : `route:${source}:${u.id}`,
            rid: u.id,
          }
        : {}),
      source,
      via: 'route',
      provider: r.provider,
      model: u.model || r.model,
      promptTokens: u.input + u.cacheRead + u.cacheWrite,
      outputTokens: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      ...(u.cacheWrite1h ? { cacheWrite1h: u.cacheWrite1h } : {}),
      ...(u.fast ? { fast: true } : {}),
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
    this.startQuotaAutoTimer();
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

  private startQuotaAutoTimer(): void {
    if (this.quotaAutoTimer || (this.d.scanMs ?? 60_000) <= 0) return;
    this.quotaAutoTimer = setInterval(() => void this.autoRefreshQuota(), QUOTA_AUTO_CHECK_MS);
    (this.quotaAutoTimer as { unref?: () => void }).unref?.();
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
    if (this.quotaAutoTimer) clearInterval(this.quotaAutoTimer);
    this.quotaAutoTimer = null;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.ledger.close();
  }

  async scan(): Promise<{ added: number; files: number }> {
    if (!this.settings.enabled || !this.settings.readToolLogs || this.scanning)
      return { added: 0, files: 0 };
    this.scanning = true;
    try {
      // 游标与去重都要完整账本：后台载入没完成就先等它
      await this.ledger.whenReady();
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
    // 账本还在后台载入：数据不全不判断（载入完成后会再安排一次检查）
    if (!this.ledger.isLoaded()) return;
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
            'electron.common.spending-has-exceeded-the-budget',
            period,
            this.money(cost),
            formatAmount(budget, s.currency),
          )
        : tr(
            'electron.common.spending-has-reached-80-of-the-budget',
            period,
            this.money(cost),
            formatAmount(budget, s.currency),
          );
    if (dl > this.alertState.dayLevel && dl > 0)
      fire.push({
        scope: 'day',
        level: dl as 80 | 100,
        text: text(tr('electron.common.today-s'), day, s.dailyBudget, dl as 80 | 100),
      });
    if (ml > this.alertState.monthLevel && ml > 0)
      fire.push({
        scope: 'month',
        level: ml as 80 | 100,
        text: text(tr('electron.common.this-month-s'), month, s.monthlyBudget, ml as 80 | 100),
      });
    if (!fire.length) return;
    const top = fire.some((f) => f.level === 100) ? 100 : 80;
    const body =
      fire.map((f) => f.text).join(' ') +
      (unpriced ? tr('electron.common.unpriced-models-are-not-counted') : '');
    const delivered = this.d.alert?.({
      kind: top === 100 ? 'budget-100' : 'budget-80',
      title: tr('electron.common.usage-budget-alert'),
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
      title: tr('electron.common.a-single-task-is-costing-a-lot'),
      text: tr(
        'electron.common.this-task-has-already-cost-about-alert-line',
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
    if (u.costUsd === null)
      return tr('electron.common.this-task-used-about-tokens-model-unpriced-cost', tokens);
    const cost = this.money(u.costUsd);
    return u.unpriced
      ? tr('electron.common.this-task-used-about-tokens-the-priced-part', tokens, cost)
      : tr('electron.common.this-task-used-about-tokens-and-cost-about', tokens, cost);
  }

  // ---------------------------------------------------------------- 查询

  private priceOf() {
    return makePriceOf(this.settings.customPrices, this.priceSync.entries());
  }

  /**
   * 长上下文的计价（「模型」页与输入栏提示「超过标准窗口按多少计费」）：
   * 有按长度分档的价格时返回最高一档的门槛与单价，否则 undefined。
   */
  longContextPrice(
    model: string,
  ):
    | { size: number; input: number; output: number; tierInput: number; tierOutput: number }
    | undefined {
    const m = this.priceOf()(model);
    const tiers = m?.price.tiers;
    if (!m || !tiers?.length) return undefined;
    const top = tiers.reduce((a, b) => (b.size > a.size ? b : a));
    return {
      size: top.size,
      input: m.price.input,
      output: m.price.output,
      tierInput: top.input ?? m.price.input,
      tierOutput: top.output ?? m.price.output,
    };
  }

  /**
   * 按当前价格表（内置 + 同步 + 自定义）估算一次调用的费用（USD），未定价返回 undefined。
   * 模型质量记录用；input 为未命中缓存的输入。
   */
  costOf(
    model: string,
    t: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  ): number | undefined {
    const m = this.priceOf()(model);
    if (!m) return undefined;
    return costUsd(
      {
        input: t.input ?? 0,
        output: t.output ?? 0,
        cacheRead: t.cacheRead ?? 0,
        cacheWrite: t.cacheWrite ?? 0,
      },
      m.price,
    );
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
      // 落盘降级（写不进磁盘、记录暂存在内存等待重试）对用户可见（#42）
      persist: this.ledger.persistState(),
      pricing: {
        date: PRICING_TABLE_DATE,
        builtin: BUILTIN_PRICES.map((p) => ({ ...p })),
        sync: this.priceSync.state(),
      },
    };
  }

  /**
   * 同步模型数据（价格 + 模型参数）：用户点「立即同步」，或启动时由 autoSync 调用。
   * 只下载 models.dev 的公开数据，不上传任何用量。返回结果 + 最新状态；成功后通知各窗口刷新。
   */
  async syncPrices(): Promise<{ result: PriceSyncResult } & ReturnType<UsageService['state']>> {
    const result = await this.priceSync.sync();
    if (result.ok) this.changed();
    return { result, ...this.state() };
  }

  /**
   * 启动时自动同步：用户没关「启动时自动同步」、且距上次与服务器核对超过 12 小时才联网；
   * 网关还没有模型目录缓存时不等 12 小时（否则刚升级的版本要等半天才有新模型）。
   */
  async autoSync(): Promise<void> {
    if (!this.settings.modelsSyncAuto) return;
    const last = this.priceSync.state().checkedAt;
    if (last && this.now() - last < MODELS_SYNC_INTERVAL_MS && !this.d.needsFullModelsData?.())
      return;
    await this.syncPrices();
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

  /**
   * 「按端」信息卡用：某一个端（nomi / claude / codex / dsh / grok）的今日 / 近 7 天用量、
   * 按天趋势、模型与供应商分布。只聚合本机账本，不读任何凭据。
   */
  endpointUsage(source: string) {
    const now = this.now();
    const priceOf = this.priceOf();
    const week = rangeOf('7d', now);
    const today = rangeOf('today', now);
    const recs = this.ledger.range(week.from, week.to).filter((r) => r.source === source);
    const todayRecs = recs.filter((r) => r.ts >= today.from);
    return {
      source,
      today: summarize(todayRecs, priceOf),
      week: summarize(recs, priceOf),
      series: series(recs, week, priceOf),
      byModel: breakdown(recs, 'model', priceOf, this.labels()),
      byProvider: breakdown(recs, 'provider', priceOf, this.labels()),
      lastActivityAt: this.ledger.lastTs(source),
    };
  }

  heatmap() {
    const now = this.now();
    const today = startOfDay(now);
    const ver = this.ledger.version();
    const prices = this.settings.customPrices;
    const priceVer = this.priceSync.version();
    const c = this.heatCache;
    if (c && c.ver === ver && c.prices === prices && c.priceVer === priceVer && c.today === today)
      return { days: c.days, today: dateKey(now) };
    // 只取热力图覆盖的 365 天（heatmap 自己也按这个窗口过滤；range 是按时间排好的同一份子序列，结果不变）
    const recs = this.ledger.range(addDays(today, -364), addDays(today, 1));
    const days = heatmap(recs, now, this.priceOf());
    this.heatCache = { ver, prices, priceVer, today, days };
    return { days, today: dateKey(now) };
  }

  details(q: DetailQuery) {
    // details 先按 [from, to) 过滤：二分取区间代替拷贝整本账（顺序相同，结果不变）
    return details(this.ledger.range(q.from, q.to), q, this.priceOf(), this.labels());
  }

  csv(q: DetailQuery): string {
    const recs = this.ledger
      .range(q.from, q.to)
      .filter(
        (r) =>
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
    this.quotaEpoch++; // 让进行中的刷新作废（缓存各自也会换代）
    // 清空前发起、还没结束的刷新 Promise 不能被清空后的刷新复用（它们的结果都是 superseded，#45）
    this.toolCore.clear();
    this.toolRefreshing.clear();
    this.refreshing = null;
    this.codexCache.clear();
    this.claudeCache.clear();
    this.grokCache.clear();
    this.auth.forgetKnown();
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
    // 经 guardedHandle：sender + senderFrame 校验、通道认领；业务错误仍以 { __error } 信封返回
    const handle = (ch: string, fn: (...a: unknown[]) => unknown | Promise<unknown>) =>
      guardedHandle(ch, fn, { owner: 'UsageService' });
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
    // 读账本的查询：大账本后台载入完成前先等，界面拿到的总是完整数据
    const ready = this.ledger.whenReady();
    handle('ai:usage:state', async () => {
      await ready;
      return this.state();
    });
    handle('ai:usage:query', async (r) => {
      await ready;
      return this.query(rid(r));
    });
    handle('ai:usage:heatmap', async () => {
      await ready;
      return this.heatmap();
    });
    handle('ai:usage:endpoint', async (id) => {
      await ready;
      return this.endpointUsage(endpointSourceOf(id));
    });
    handle('ai:usage:details', async (q) => {
      await ready;
      return this.details(dq(q));
    });
    handle('ai:usage:csv', async (q) => {
      await ready;
      return this.csv(dq(q));
    });
    handle('ai:usage:set-settings', (p) => this.setSettings((p ?? {}) as Partial<UsageSettings>));
    handle('ai:usage:quota', () => this.quotaViewed());
    handle('ai:usage:quota-refresh', (tool) => this.refreshQuota(quotaToolOf(tool)));
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

/** IPC 参数校验：只接受已知工具 id；其他（含缺省）= 全部刷新 */
export const quotaToolOf = (v: unknown): QuotaToolId | undefined =>
  v === 'claude' || v === 'codex' || v === 'grok' ? v : undefined;

/** 「按端」只接受已知端；其他值一律按 nomi 处理，避免任意字符串进入查询 */
export const endpointSourceOf = (v: unknown): string =>
  v === 'claude' || v === 'codex' || v === 'dsh' || v === 'grok' || v === 'gemini' ? v : 'nomi';

let inst: UsageService | null = null;
export function initUsageService(d: Deps): UsageService {
  inst?.stop();
  inst = new UsageService(d);
  return inst;
}
export function getUsageService(): UsageService | null {
  return inst;
}
