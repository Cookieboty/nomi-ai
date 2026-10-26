/**
 * 网关的运行时配置快照（docs/design/unified-gateway.md §5.3、§6.1）。
 * 由主进程从 store.json 生成：Key 已解密，只在内存里；配置改动时整份替换，进行中的请求继续用旧快照。
 */
import type { Wire } from './ir';

/** 内置的客户端（Nomi 自己 + 内置编程助手插件）；宿主据此管理各客户端的令牌 */
export type BuiltinClientId = 'nomi' | 'claude' | 'codex' | 'gemini' | 'grok' | 'dsh';

/**
 * 客户端 id 是开放的（P9.4）：任何登记了客户端规格的 id（registerClientSpec）都可以用；
 * 网关只认已登记的（认身份时校验）。保留内置 id 的字面量以便补全。
 */
export type ClientId = BuiltinClientId | (string & {});

/** 内置客户端 id（宿主的令牌存储按它建）；网关认身份不再用它，改看已登记的规格 */
export const CLIENT_IDS: readonly BuiltinClientId[] = [
  'nomi',
  'claude',
  'codex',
  'gemini',
  'grok',
  'dsh',
];

export type AuthStyle = 'bearer' | 'x-api-key' | 'x-goog-api-key';

export interface RuntimeKey {
  id: string;
  name?: string;
  /** 明文（只在网关进程内存里） */
  value: string;
  /** 只对这种协议有效 */
  wire?: Wire;
  enabled: boolean;
  /** 这个 Key 的并发上限 / 每分钟请求数（§6.11.3）；优先于供应商规格与 quirks */
  maxConcurrency?: number;
  rpm?: number;
}

export interface RuntimeModel {
  id: string;
  enabled: boolean;
  /** 手动限定这个模型能走的协议 */
  wires?: Wire[];
  ctx?: number;
  maxOutput?: number;
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  label?: string;
  /** 用户设置的可用思考档位（§6.9.3 第 5 级；发送前按它贴合） */
  efforts?: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  /** 严格模式（§6.9.6）：不支持的参数直接报错而不是丢弃；不设时跟网关配置的 strictParams */
  strict?: boolean;
}

/** 运行时学到的、某个模型的结论（§6.9.8）：带时间与目录版本，过期或目录升级后重新验证 */
export interface LearnedModel {
  at: number;
  catalogVersion?: string;
  /** 实际接受的思考档位 */
  efforts?: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  /** 拒绝非默认温度 */
  temperature?: false;
}

export interface ProbeState {
  ok: boolean;
  auth?: AuthStyle;
}

export interface ProviderQuirks {
  responsesTellsCache?: boolean;
  preferWire?: Wire;
  maxTools?: number;
  dropParams?: string[];
  /** 多轮工具调用时必须把历史推理原样发回（DeepSeek、MiniMax 的 Chat 接口），否则 400 */
  reasoningPassback?: boolean;
  userAgent?: string;
  /** 每个 Key 的并发上限 / 每分钟请求数（§6.11.3）；超出时排队，等不到换下一个候选 */
  maxConcurrency?: number;
  rpm?: number;
  /**
   * 按上游协议合并进请求体的额外字段（协议转换与请求修正之后、dropParams 之前），
   * 如 MiniMax Chat 的 reasoning_split
   */
  extraBody?: Partial<Record<Wire, Record<string, unknown>>>;
  /** 针对上游毛病的修正开关（§11.3、§12.7.3），都默认开；设为 false 关掉 */
  fixes?: {
    /** Chat 流修正（空 reasoning_content、finish_reason ""、重复空工具名、空 tool_calls） */
    chatStream?: boolean;
    /** 正文里写出的工具调用转成工具调用 */
    textToolCalls?: boolean;
    /** 复读检测 */
    repetition?: boolean;
    /** Chat 上游的工具名映射 */
    toolNames?: boolean;
  };
}

export interface RuntimeProvider {
  id: string;
  aliases?: string[];
  name: string;
  enabled: boolean;
  urls: Partial<Record<Wire, string>>;
  keys: RuntimeKey[];
  models: RuntimeModel[];
  /** 本供应商失败时依次尝试的 provider/model */
  fallback?: string[];
  headers?: Record<string, string>;
  userAgent?: string;
  /** 对外名 → 上游真实名 */
  modelMap?: Array<{ from: string; to: string }>;
  /** 探测结果：任一 Key 可用即 ok；未探测过的协议视为可用（有地址就试） */
  detected?: Partial<Record<Wire, ProbeState>>;
  /** 配置里的厂商差异（预设 + 用户设置）；覆盖供应商规格自带的（§6.3） */
  quirks?: ProviderQuirks;
  /** 创建时用的预设 id（ai-runtime presets）：按它匹配供应商规格（§6.3 match.presets） */
  preset?: string;
  /** 用户手动指定的供应商规格 id（'generic' | 'amux' …）；优先于预设与域名匹配 */
  spec?: string;
}

export interface ClientModels {
  main?: string;
  /** 旧版本的「小模型」：界面已并入 Haiku 档，只读作 Haiku 档没设时的值 */
  small?: string;
  tiers?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'fable', string>>;
  subagent?: string;
  tools?: string;
  /**
   * 辅助模型（§6.7，Q2）：生成标题、摘要、下一句提示等辅助请求用，通常选同一供应商里更便宜的模型；
   * 没设时跟主模型。CLI 发的辅助模型名由客户端规格的 helperModels 识别。
   */
  summary?: string;
}

export interface ClientRuntime {
  token: string;
  models: ClientModels;
}

/** 运行时学到的状态（§7.4），主进程持久化后随快照带回来 */
export interface LearnedState {
  wireDown?: Partial<Record<Wire, { at: number; reason: string }>>;
  modelWire?: Record<string, Wire[]>;
  droppedParams?: Record<string, string[]>;
  /** Responses 接口拒绝 custom 工具的模型：之后都从转换模式开始（§11.3） */
  customToolsRefused?: string[];
  /** 按模型学到的结论（错误修正器，§6.9.8） */
  models?: Record<string, LearnedModel>;
}

/** 请求体上限默认 32 MiB；高级设置可调，夹在 1..256 MiB */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
export const MIN_MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
export const MAX_MAX_REQUEST_BODY_BYTES = 256 * 1024 * 1024;

export function clampMaxRequestBodyBytes(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_MAX_REQUEST_BODY_BYTES;
  return Math.min(MAX_MAX_REQUEST_BODY_BYTES, Math.max(MIN_MAX_REQUEST_BODY_BYTES, Math.floor(n)));
}
export interface GatewayConfig {
  host: string;
  port: number;
  providers: RuntimeProvider[];
  clients: Partial<Record<ClientId, ClientRuntime>>;
  /** 旧版本写进全局配置的共享令牌：撤销完成前继续接受（§10.2） */
  legacyToken?: string;
  /** 用户确认过的回环 / 私网上游（host:port），见 §15 */
  allowedPrivateHosts?: string[];
  learned?: Record<string, LearnedState>;
  /** 会话归属表文件（§11.4）；缺省只在内存里 */
  sessionsFile?: string;
  /** 运行时同步到的模型目录（models.dev，§12.7.2）；有就作为内置目录的覆盖层 */
  catalogFile?: string;
  /** 调试追踪目录（§14「调试模式」）：设置了才把请求 / 响应正文脱敏后写到这里，24 小时自动删除 */
  traceDir?: string;
  /** 严格模式（§6.9.6，默认关）：模型不支持的参数直接报错，而不是丢弃并记录 */
  strictParams?: boolean;
  /** 入站请求体上限（字节）；不设 = 32 MiB，见 clampMaxRequestBodyBytes */
  maxRequestBodyBytes?: number;
  /**
   * 路由计划（§6.9.4）：active（默认，未设亦同）= 按新计划选上游协议（模型原生协议优先）；
   * shadow = 只计算新计划、与现有选协议规则比对写日志（回滚用，NOMI_ROUTE_PLAN=shadow）。
   */
  routePlan?: 'shadow' | 'active';
  /** 隐私模式（docs/design/secret-privacy.md）：不设 = 关；主进程默认给 enabled: true */
  privacy?: PrivacyConfig;
}

export interface PrivacyConfig {
  /** true = 发往云端前把密钥换成占位符、回程换回来；false = 原样发出 */
  enabled: boolean;
  /** 严格档（键名像密钥的赋值 + 熵） */
  strict?: boolean;
  /** 本机 / 局域网上游也脱敏 */
  local?: boolean;
  /** 形状保持模式：key 换成同形状的假 key 而不是占位符（§13） */
  shape?: boolean;
  /** 占位符 HMAC 密钥（主进程生成，safeStorage 存储） */
  key: string;
  /** 额外的已知原文：主进程里其他服务的密钥、用户登记的自定义密钥 */
  known?: Array<{ kind: string; value: string }>;
  /** 按类型的动作；没列出的类型是 mask */
  actions?: Record<string, 'warn' | 'block'>;
  /** 「从不脱敏」名单的标记（allowTagOf） */
  allow?: string[];
}
