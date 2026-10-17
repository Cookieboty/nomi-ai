/** 用量与计费：共享类型（主进程内部；渲染进程在 ai-chat/services/usageClient.ts 里有对应声明） */

/** 来源：Nomi 对话 / 各编程工具 / 其他自定义供应商 */
export type UsageSource =
  | 'nomi'
  | 'claude'
  | 'codex'
  | 'dsh'
  | 'grok'
  | 'gemini'
  | 'qwen'
  | 'opencode'
  | 'copilot'
  | 'kimi'
  | 'aider'
  | 'cline'
  | 'continue'
  | 'cursor'
  | 'other';

/** 数据通道：Nomi 对话 / 本地路由经过 / 读取编程工具自己的会话日志 */
export type UsageVia = 'chat' | 'route' | 'log';

/**
 * 一次调用。token 口径统一为：
 * - input：未命中缓存的输入；cacheRead / cacheWrite：缓存读 / 写（都属于输入）；
 * - output：输出（含推理 token）。
 */
export interface UsageRecord {
  /** 去重键：同一键再次写入视为同一条调用的更新（取较大的 token 数） */
  key: string;
  /** 调用开始时间（ms） */
  ts: number;
  /** 路由请求的耗时（ms），用来和同一时段的日志记录去重 */
  dur?: number;
  source: UsageSource;
  via: UsageVia;
  provider?: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  /** 缓存写总量（含 1h 档）；旧账本只有这一个字段，整体按 5 分钟档计价 */
  cacheWrite: number;
  /**
   * 缓存写里属于 1 小时档的部分（≤ cacheWrite，余量即 5 分钟档）。缺省 = 0，按旧口径全部当 5 分钟档。
   * 只有能拆出分档的来源（Claude 的 cache_creation.ephemeral_*）才会写它。
   */
  cacheWrite1h?: number;
  /** true = 这次请求走了「快速模式」（Claude usage.speed === 'fast'），输入输出按 2 倍计价；缺省 = 标准速度 */
  fast?: boolean;
  /** 会话 id（CLI 会话 id / Nomi 对话 id） */
  session?: string;
  /** 项目目录名 */
  project?: string;
  /** true = 上游没返回 usage，数值为估算 */
  est?: boolean;
}

export type Currency = 'USD' | 'CNY';

/**
 * 长上下文分档：单次请求的提示词 token（input + 缓存读 + 缓存写）严格大于 size 时，改用这一档的价格
 * （models.dev 的 cost.tiers 口径，例如 gpt-5.4 在 272000 以上输入价翻倍）。
 * 档里没写的缓存价沿用基础价。
 */
export interface PriceTier {
  size: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** 单价：USD / 1M tokens */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  /** 缓存写（5 分钟档，没有分档的模型就是唯一的缓存写价） */
  cacheWrite?: number;
  /** 缓存写 1 小时档；缺省时按 2 × 输入价（Anthropic 公布的倍率） */
  cacheWrite1h?: number;
  /** 长上下文分档（按 size 升序）；没有 = 不分档 */
  tiers?: PriceTier[];
}

export interface PriceEntry extends ModelPrice {
  /** 匹配用的规范化模型名（小写；版本号分隔统一为 -） */
  model: string;
  /** 展示名 */
  label?: string;
  /** 备注（例如「≤272K 上下文价」） */
  note?: string;
}

/** 用户自定义 / 覆盖的价格 */
export interface CustomPrice extends ModelPrice {
  model: string;
}
