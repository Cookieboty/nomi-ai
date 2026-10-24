/**
 * 模型质量（docs/design/model-quality.md）：网关层与 CLI 层的质量记录、查询与结果。
 * 主进程（记录、聚合）与对话窗口（展示）共用这份契约；只含元数据，不含对话内容。
 */

/**
 * 测量口径：
 * - gateway：经 Nomi 统一网关的请求（Nomi 对话、编程助手的第三方供应商），按 HTTP 请求计，最精确；
 * - cli：Nomi 里运行的编程助手会话（官方账号与第三方都有），按 CLI 输出流的一轮 / 一次模型调用计，
 *   时间含 CLI 自身开销，没有 Key 与 HTTP 细节。
 * 两种口径不直接混算，界面分开显示或标注。
 */
export type QualityLayer = 'gateway' | 'cli';

/** 一次请求 / 一轮的结果（§2.3） */
export type QualityOutcome =
  | 'ok'
  | 'client-cancel'
  | 'auth'
  | 'rate-limit'
  | 'upstream-5xx'
  | 'first-byte-timeout'
  | 'pre-commit-error'
  | 'stream-break'
  | 'idle-timeout'
  | 'protocol-violation'
  | 'repetition-stop'
  | 'request-rejected'
  | 'gateway-error'
  /** CLI 层：CLI 报告的错误（API 错误、额度、鉴权等） */
  | 'cli-error'
  /** CLI 层：进程在一轮中途退出 */
  | 'cli-exit';

/** 各阶段时间点，都相对记录起点 ts（ms） */
export interface QualityTiming {
  /** 上游响应头（仅网关层） */
  headersMs?: number;
  /** 第一个内容事件（正文 / 推理 / 工具参数任一）= TTFT */
  firstContentMs?: number;
  /** 第一个正文 token */
  firstTextMs?: number;
  /** 最后一个内容事件 */
  lastContentMs?: number;
  /** 结束（最后一个字节写给客户端 / 这一轮结束）= E2E */
  endMs: number;
}

export interface QualityTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** 网关层：每个候选一次尝试（供应商 / Key 视角按尝试计数） */
export interface QualityAttempt {
  provider: string;
  keyId?: string;
  model: string;
  upstreamWire?: string;
  status?: number;
  outcome: QualityOutcome;
  ms: number;
  headersMs?: number;
  /** 失败的简短类别（不含正文） */
  errorKind?: string;
}

export interface QualityRecord {
  id: string;
  layer: QualityLayer;
  /** 起点（epoch ms）：网关收到请求 / CLI 这一轮发出 */
  ts: number;
  /** 客户端：nomi | claude | codex | grok | gemini | dsh | 外部 CLI 的 id */
  client: string;
  /** 来源：Nomi 对话、编程助手官方账号、编程助手第三方供应商 */
  source: 'nomi' | 'official' | 'thirdParty';
  tabId?: string;
  generation?: number;
  /** 官方账号 id（CLI 层、官方来源） */
  accountId?: string;
  /** 供应商 id（网关层；官方来源为 CLI 的官方服务，如 anthropic / openai / xai / google） */
  provider?: string;
  keyId?: string;
  /** 对外模型名（网关：`供应商/模型`；官方：CLI 报告或标签选的模型） */
  model?: string;
  /** 上游真实模型名 */
  upstreamModel?: string;
  /** 归一后的模型族（跨供应商对比用） */
  modelFamily?: string;
  ingress?: string;
  wire?: string;
  /** 透传 / 转换 */
  mode?: 'passthrough' | 'convert';
  /** 模型解析方式（显式 / 绑定 / 档位 / 辅助…） */
  resolved?: string;
  stream: boolean;
  reasoning?: boolean;
  outcome: QualityOutcome;
  status?: number;
  errorKind?: string;
  /** 取消发生在第一个内容之前还是输出中 */
  cancelPhase?: 'before-first' | 'during';
  timing: QualityTiming;
  tokens: QualityTokens;
  cost?: number;
  /** 网关层：各候选的尝试；第一个失败、后面成功 = 回退 */
  attempts?: QualityAttempt[];
  /** CLI 层：CLI 报告的 API 重试次数 */
  retries?: number;
  /** 生成时长 < 100 ms 且输出 ≥ 20 token：上游缓冲后整段吐出 */
  burst?: boolean;
  traceId?: string;
  /** 网关对请求做的修正（如去掉了 temperature、压低了输出上限、省略了图片），只有网关层有 */
  notes?: string[];
}

/** 可分组 / 筛选的维度 */
export type QualityDimension =
  | 'provider'
  | 'key'
  | 'model'
  | 'modelFamily'
  | 'client'
  | 'source'
  | 'protocol'
  | 'resolved'
  | 'outcome';

export interface QualityQuery {
  from: number;
  to: number;
  /** 不给 = gateway */
  layer?: QualityLayer;
  filters?: Partial<Record<QualityDimension, string[]>>;
  groupBy?: QualityDimension;
  /** 计数口径：请求（默认）/ 尝试（供应商、Key 视角，仅网关层） */
  countBy?: 'request' | 'attempt';
  /** 取消计入成功率分母（默认 false） */
  cancelInDenominator?: boolean;
  /** 请求被拒（400 / 上下文超长等）计入失败（默认 false） */
  includeRejected?: boolean;
  /** 同时给出上一个等长周期的总计，用于升降对比 */
  withPrevious?: boolean;
}

export interface QualityDist {
  n: number;
  mean?: number;
  p50?: number;
  p90?: number;
  p99?: number;
}

export interface QualityStats {
  /** 分组键（总计为 '*'） */
  key: string;
  label: string;
  requests: number;
  attempts: number;
  ok: number;
  failed: number;
  cancelled: number;
  cancelBeforeFirst: number;
  cancelDuring: number;
  streamBreak: number;
  fallback: number;
  burst: number;
  successRate?: number;
  failureRate?: number;
  cancelRate?: number;
  streamBreakRate?: number;
  fallbackRate?: number;
  /** 按 token：缓存读 ÷ 输入总量（统一口径） */
  cacheHitTokenRate?: number;
  /** 按请求：有缓存读的请求 ÷ 请求数 */
  cacheHitRequestRate?: number;
  failures: Partial<Record<QualityOutcome, number>>;
  ttfb: QualityDist;
  ttft: QualityDist;
  /** 首个正文 token */
  ttftText: QualityDist;
  tpot: QualityDist;
  e2e: QualityDist;
  /** 输出 token ÷ 生成时长 */
  outputTps: QualityDist;
  tokens: Required<QualityTokens>;
  cost?: number;
}

export interface QualityResult {
  total: QualityStats;
  groups: QualityStats[];
  previous?: QualityStats;
  /** 样本不足（< 20）时界面只显示中位数 */
  minSamples: number;
}

export interface QualitySeriesQuery extends QualityQuery {
  bucket: 'hour' | 'day';
  metric:
    | keyof Pick<
        QualityStats,
        | 'requests'
        | 'successRate'
        | 'failureRate'
        | 'cancelRate'
        | 'streamBreakRate'
        | 'cacheHitTokenRate'
      >
    | 'ttft.p50'
    | 'ttft.p90'
    | 'tpot.p50'
    | 'e2e.p50'
    | 'e2e.p90'
    | 'outputTps.p50';
}

export interface QualitySeries {
  buckets: number[];
  series: Array<{ key: string; label: string; values: Array<number | null> }>;
}

export interface QualityRequestsQuery {
  from: number;
  to: number;
  layer?: QualityLayer;
  filters?: Partial<Record<QualityDimension, string[]>>;
  limit: number;
  offset?: number;
}

export interface QualitySettings {
  /** 保留天数：7 / 30 / 90 */
  retentionDays: number;
}

/** IPC（主进程 QualityService，经 guardedHandle） */
export const QUALITY_IPC = {
  query: 'ai:quality:query',
  series: 'ai:quality:series',
  requests: 'ai:quality:requests',
  settingsGet: 'ai:quality:settings-get',
  settingsSet: 'ai:quality:settings-set',
  clear: 'ai:quality:clear',
  /** 导出 CSV（弹保存对话框）：参数 QualityExportRequest，返回 QualityExportResult */
  export: 'ai:quality:export',
  changed: 'ai:quality:changed',
} as const;

/** 导出：请求明细，或按维度分组的对比表 */
export type QualityExportRequest =
  { kind: 'requests'; query: QualityRequestsQuery } | { kind: 'table'; query: QualityQuery };

export interface QualityExportResult {
  /** 用户取消保存时为 false */
  ok: boolean;
  path?: string;
  rows: number;
}
