/**
 * 网关的持久化结构：userData/gateway/store.json（docs/design/unified-gateway.md §6.1）。
 * Key 与客户端令牌只存密文；运行时快照（GatewayConfig，Key 已解密）由 GatewayStore.runtimeConfig() 生成。
 */
import type { ClientId, ClientModels, LearnedState, ProviderQuirks, Wire } from '@nomi-ai/gateway';

export type KeyEncryption = 'safeStorage' | 'none';

export interface GatewayKey {
  id: string;
  name?: string;
  /** 密文（base64）；encryption 记录用的是哪种方式（旧存储没有前缀，必须单独记） */
  enc: string;
  encryption: KeyEncryption;
  masked: string;
  wire?: Wire;
  enabled: boolean;
  lastError?: string;
  /** 这个 Key 的并发上限 / 每分钟请求数（§6.11.3）；不设 = 不限 */
  maxConcurrency?: number;
  rpm?: number;
}

export interface GatewayModel {
  id: string;
  enabled: boolean;
  label?: string;
  wires?: Wire[];
  ctx?: number;
  maxOutput?: number;
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  metaSource?: 'user' | 'preset' | 'listed' | 'catalog' | 'default';
}

export interface StoredProbe {
  ok: boolean;
  status?: number;
  at: number;
  model?: string;
  auth?: 'bearer' | 'x-api-key' | 'x-goog-api-key';
  error?: string;
}

export interface GatewayProvider {
  id: string;
  aliases?: string[];
  name: string;
  presetId?: string;
  enabled: boolean;
  urls: Partial<Record<Wire, string>>;
  keys: GatewayKey[];
  models: GatewayModel[];
  modelsSource: 'listed' | 'manual' | 'preset';
  fallback?: string[];
  headers?: Record<string, string>;
  userAgent?: string;
  modelMap?: Array<{ from: string; to: string }>;
  source: 'user' | 'env';
  detected?: Partial<Record<Wire, StoredProbe>>;
  detectedByKey?: Record<string, Partial<Record<Wire, StoredProbe>>>;
  quirks?: ProviderQuirks;
  createdAt: number;
  updatedAt: number;
}

export interface ClientConfig {
  newTabSource?: 'official' | 'thirdParty';
  tokenEnc: string;
  tokenEncryption: KeyEncryption;
  models: ClientModels;
}

export interface GatewayStoreData {
  version: 1;
  providers: GatewayProvider[];
  clients: Partial<Record<ClientId, ClientConfig>>;
  learned: Record<string, LearnedState>;
  /** 用户确认过的回环 / 私网上游 host:port（§15） */
  allowedPrivateHosts: string[];
  port: number;
  /** Nomi 对话最近用过的模型（`供应商/模型`，新的在前，最多 5 个；托盘菜单用） */
  recentNomi?: string[];
  /** 一次性迁移的来源与时间（§6.3） */
  migratedFrom?: { at: number; files: string[] };
  /** 严格模式（§6.9.6，默认关）：模型不支持的参数直接报错，而不是丢弃并记录 */
  strictParams?: boolean;
}
