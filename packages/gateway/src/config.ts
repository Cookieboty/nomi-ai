/**
 * 网关的运行时配置快照（docs/design/unified-gateway.md §5.3、§6.1）。
 * 由主进程从 store.json 生成：Key 已解密，只在内存里；配置改动时整份替换，进行中的请求继续用旧快照。
 */
import type { Wire } from './ir';

export type ClientId = 'nomi' | 'claude' | 'codex' | 'gemini' | 'grok' | 'dsh';

export const CLIENT_IDS: readonly ClientId[] = ['nomi', 'claude', 'codex', 'gemini', 'grok', 'dsh'];

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
  /** 调试追踪目录（§14「调试模式」）：设置了才把请求 / 响应正文脱敏后写到这里，24 小时自动删除 */
  traceDir?: string;
}
