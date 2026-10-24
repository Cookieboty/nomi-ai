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
  /**
   * RoutePlan 预期损失（网关层；字符串与 gateway Loss 对齐）。
   * 聚合维度 `loss` 取 losses[0]（主损失），避免组合键基数爆炸；完整列表仍落盘供明细与 /metrics。
   */
  losses?: string[];
  /** RoutePlan 质量档（网关层；字段名避开 outcome） */
  routeQuality?: 'lossless' | 'good' | 'degraded';
}

/** 请求明细的一行：记录本身 + 主进程补的展示名（不落盘） */
export interface QualityRequestItem extends QualityRecord {
  /** 模型的厂商（「OpenAI」），认不出没有 */
  vendor?: string;
  /** 好读的模型名（「GPT-6.1 Sol」） */
  display?: string;
  /** 供应商的名字（已配置的第三方供应商 / 官方服务），认不出没有 */
  providerName?: string;
  /** Key 的名字，认不出没有 */
  keyName?: string;
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
  | 'outcome'
  /** RoutePlan 质量档 lossless | good | degraded */
  | 'routeQuality'
  /**
   * 主损失：取 QualityRecord.losses[0]（有序；见 lossesOf）。
   * 不用 losses 组合当键，避免基数爆炸；多损失明细仍在记录与网关 /metrics.byLoss。
   */
  | 'loss';

export interface QualityQuery {
  from: number;
  to: number;
  /** 不给 = gateway */
  layer?: QualityLayer;
  filters?: Partial<Record<QualityDimension, string[]>>;
  groupBy?: QualityDimension;
  /**
   * 多级分组（1～3 级，如 模型族 → 供应商 → Key）：结果的每一组带 children。给了它就不看 groupBy。
   */
  groupPath?: QualityDimension[];
  /**
   * 计数口径（仅网关层）：request（默认）一切按请求计；attempt 时「成功 / 失败 / 客户端错误 / 总数 /
   * 成功率 / 失败率」按上游尝试计（一次请求回退到多个候选时计多次，失败的 Key 不被后面的成功掩盖），
   * 其余各列（取消、断流、缓存、延迟、token）仍按请求计。
   */
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
  p95?: number;
  p99?: number;
}

export interface QualityStats {
  /** 分组键（总计为 '*'） */
  key: string;
  label: string;
  /** 这一组所在的维度（总计没有） */
  dim?: QualityDimension;
  /** 模型 / 模型族的厂商（OpenAI、DeepSeek、Google…），界面显示品牌图标与「厂商: 模型」 */
  vendor?: string;
  /** 模型的显示名（如 GPT-6.1 Sol）；没有时用 label */
  display?: string;
  /** 供应商组的来源：官方账号 / 第三方 / Nomi 对话；混合时不给 */
  tag?: 'official' | 'thirdParty' | 'nomi';
  /** 多级分组的下一级 */
  children?: QualityStats[];
  requests: number;
  attempts: number;
  /** 计数单位总数（按 countBy：请求或尝试） */
  total: number;
  ok: number;
  /** 失败（不含客户端错误；includeRejected 时含） */
  failed: number;
  /** 客户端错误：请求本身的问题（400 / 404 / 413 / 上下文超长等，结果为 request-rejected） */
  clientErrors: number;
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
  /** 输入长度（每次请求的输入 token，含缓存读写） */
  inputLen: QualityDist;
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
    | 'ttft.p95'
    | 'tpot.p50'
    | 'e2e.p50'
    | 'e2e.p90'
    | 'e2e.p95'
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
  /** 筛选项：这段时间里出现过的客户端 / 供应商 / 模型族 / Key（参数 QualityQuery，返回 QualityFacets） */
  facets: 'ai:quality:facets',
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

/** 一个维度在这段时间里出现过的取值（筛选下拉用），按出现次数降序 */
export interface QualityFacet {
  key: string;
  label: string;
  count: number;
  /** 模型族的厂商（显示品牌图标） */
  vendor?: string;
}

export type QualityFacets = Partial<Record<QualityDimension, QualityFacet[]>>;
