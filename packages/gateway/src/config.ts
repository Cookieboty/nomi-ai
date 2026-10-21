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
  quirks?: ProviderQuirks;
}

export interface ClientModels {
  main?: string;
  small?: string;
  tiers?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'fable', string>>;
  subagent?: string;
  tools?: string;
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
}
