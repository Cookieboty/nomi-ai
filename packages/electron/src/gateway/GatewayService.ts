/**
 * 网关服务（docs/design/unified-gateway.md §5、§6、§15）：主进程里的存储、迁移、网关进程守护与 IPC。
 * - 首次启动（还没有 store.json）时从旧存储迁移一次；每个客户端确保有令牌；
 * - 配置改动 → 重新生成快照推给网关进程（Key 解密只在主进程，经 parentPort 传过去，只在内存里）；
 * - 旧的本地路由服务开着且占用同一端口时，网关先用临时端口，等旧路由移除（M3）后接管；
 * - IPC 一律 ai:gateway:*；返回给渲染进程的数据里 Key 只给掩码，令牌不返回。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';
import { BUILTIN_MANIFESTS, isBuiltinCliId } from '@nomi-ai/cli-plugins';
import {
  buildCatalog,
  catalogOverlayVersion,
  catalogSize,
  CATALOG_VERSION,
  allowTagOf,
  clampMaxRequestBodyBytes,
  CLIENT_IDS,
  detect,
  isPrivateHost,
  knownSecrets,
  MIN_KNOWN,
  normalizeBases,
  previewPrivacy,
  PRIVACY_KINDS,
  preferredWire,
  type BuiltinClientId,
  type ClientId,
  type ClientModels,
  type DetectResult,
  type GatewayConfig,
  type LearnedState,
  type KeyStatusEvent,
  type LearnEvent,
  type ProviderQuirks,
  type RedactionHit,
  type RuntimeProvider,
  type UsageEvent,
  type Wire,
  readCatalogFile,
  setCatalogOverlay,
} from '@nomi-ai/gateway';

import { t as tr } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { writePrivateFileAtomicAsync } from '../utils/privateFile';

import {
  agentLaunch,
  stripGatewayLeftovers,
  type AgentKind,
  type AgentLaunch,
  type ModelMeta,
} from './agents';
import { GatewayProcess, type GatewayStatus } from './GatewayProcess';
import { GatewayStore, maskKey } from './GatewayStore';
import { archiveLegacyFiles, legacyFileCandidates, migrateLegacy } from './migrate';
import type { MetaSource, PresetModelMeta, ResolvedModelMeta } from './modelMeta';
import { PrivacyLog, type PrivacyLogEntry } from './PrivacyLog';
import { TabTokens } from './TabTokens';
import type { GatewayKey, GatewayModel, GatewayProvider, StoredProbe } from './types';

type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Key 的并发 / 每分钟请求数：正整数才记，null / 0 / 非法值清除 */
function withLimits(
  key: GatewayKey,
  input: { maxConcurrency?: number | null; rpm?: number | null },
): GatewayKey {
  const out: GatewayKey = { ...key };
  for (const f of ['maxConcurrency', 'rpm'] as const) {
    if (!(f in input)) continue;
    const v = input[f];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000) out[f] = v;
    else delete out[f];
  }
  return out;
}

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type NomiRole = 'chat' | 'agent-tools' | 'summary';

const WIRE_LABEL: Record<Wire, string> = {
  messages: 'Anthropic',
  responses: 'Responses',
  chat: 'Chat',
  gemini: 'Gemini',
};

function hasLearned(l: LearnedState | undefined): l is LearnedState {
  return Boolean(
    l &&
    (Object.keys(l.wireDown ?? {}).length ||
      Object.keys(l.modelWire ?? {}).length ||
      Object.keys(l.droppedParams ?? {}).length ||
      Object.keys(l.models ?? {}).length ||
      l.customToolsRefused?.length),
  );
}

/** 界面传来的客户端 id：只接受 nomi 与内置 CLI */
function knownClient(client: unknown): ClientId {
  if (!CLIENT_IDS.includes(client as BuiltinClientId))
    throw new Error(tr('electron.common.unknown-client'));
  return client as ClientId;
}

function hostPortOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

function privateUrl(url: string): boolean {
  try {
    return isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface ProviderInput {
  id?: string;
  name: string;
  presetId?: string;
  enabled?: boolean;
  urls: Partial<Record<Wire, string>>;
  /** 新增的 Key（明文，只在这次调用里出现） */
  newKeys?: Array<{
    value: string;
    name?: string;
    wire?: Wire;
    position?: number;
    enabled?: boolean;
    maxConcurrency?: number | null;
    rpm?: number | null;
  }>;
  /** 已有 Key 的顺序 / 启用 / 名称 / 限流（不在列表里的已有 Key 视为删除） */
  keys?: Array<{
    id: string;
    name?: string;
    enabled: boolean;
    wire?: Wire;
    maxConcurrency?: number | null;
    rpm?: number | null;
  }>;
  models?: ModelView[];
  modelMap?: Array<{ from: string; to: string }>;
  headers?: Record<string, string>;
  userAgent?: string;
  fallback?: string[];
  detected?: Partial<Record<Wire, StoredProbe>>;
  /** 预设带来的厂商差异（§12.7.4） */
  quirks?: ProviderQuirks;
}

/** 「模型」页的模型条目：存的值原样给（编辑用），另附按 §12.7.2 算出的生效值（显示用） */
export interface ModelView extends GatewayModel {
  effective?: {
    ctx: number;
    maxOutput: number;
    reasoning?: boolean;
    vision?: boolean;
    source: MetaSource;
    maxOutputSource: MetaSource;
    /** 可开长上下文：标准窗口 / 最大输入 / 模型默认是否开启 / 超过标准窗口后的单价（USD 每百万 token） */
    longContext?: {
      standard: number;
      full: number;
      on: boolean;
      price?: LongContextPrice;
    };
  };
}

export interface ProviderView extends Omit<GatewayProvider, 'keys' | 'models'> {
  keys: Array<Omit<GatewayKey, 'enc' | 'encryption'> & { decryptable: boolean }>;
  models: ModelView[];
  /** 运行时学到的状态（§7.4），「模型」页显示并可清除 */
  learned?: LearnedState;
}

/** 「试一试」最多处理多少个字符 */
const PREVIEW_MAX = 20_000;

/** ai:gateway:set-options 的参数（来自渲染进程，逐项校验类型） */
export interface GatewayOptionsPatch {
  strictParams?: unknown;
  maxRequestBodyBytes?: unknown;
  privacyMode?: unknown;
  privacyStrict?: unknown;
  privacyLocal?: unknown;
  privacyShape?: unknown;
}

export interface GatewayStateView {
  status: GatewayStatus;
  providers: ProviderView[];
  clients: Partial<
    Record<
      ClientId,
      {
        models: ClientModels;
        newTabSource?: 'official' | 'thirdParty';
        newTabAccountId?: string | null;
      }
    >
  >;
  allowedPrivateHosts: string[];
  port: number;
  /** 严格模式（§6.9.6，默认关） */
  strictParams: boolean;
  /** 入站请求体上限（字节）；默认 32 MiB */
  maxRequestBodyBytes: number;
  /** 隐私模式（默认开）：发往云端第三方供应商前把密钥换成占位符 */
  privacyMode: boolean;
  /** 隐私模式的设置：按类型的动作、自定义密钥（只有掩码）、「从不脱敏」名单（只有标记与辨认信息） */
  privacy: {
    strict: boolean;
    local: boolean;
    shape: boolean;
    actions: Record<string, 'warn' | 'block'>;
    secrets: Array<{ id: string; name: string; masked: string }>;
    allow: Array<{ tag: string; kind: string; len: number; head: string; at: number }>;
  };
  migratedFrom?: { at: number; files: string[] };
  /** Nomi 对话最近用过的模型（新的在前） */
  recentNomi?: string[];
  /** 模型目录：收录的模型数、版本（同步日；没同步过是内置目录的生成日）、是否来自同步 */
  catalog: { models: number; version: string; synced: boolean };
  /** 这次启动撤销旧版本全局配置的结果（§6.3 第 7 步）：撤销了哪些、哪些没撤成 */
  legacyRevoke?: { revoked: string[]; failed: Array<{ kind: string; error: string }> };
}

/** 长上下文计价：超过 size 个提示词 token 的请求按 tier 单价（USD / 百万 token） */
export interface LongContextPrice {
  size: number;
  input: number;
  output: number;
  tierInput: number;
  tierOutput: number;
}

export interface EnvProviderEntry {
  id: string;
  name: string;
  wire: Wire;
  url: string;
  key?: string;
  /** 提供 Key 的环境变量名（界面上显示，代替 Key 名） */
  keyEnv?: string;
  model?: string;
}

export interface GatewayServiceDeps {
  root: string;
  cipher: SecretCipher;
  logger: Logger;
  process?: GatewayProcess;
  legacy?: {
    nomiFile: string;
    cliRoot: string;
    cliDecrypt: (enc: string) => string;
    normalizeNomi: (raw: Record<string, unknown>) => ProviderStoreData;
    /** 旧版本写进 CLI 全局配置的共享令牌（撤销完成前继续接受，§10.2） */
    token: () => string | null;
    /** 旧本地路由是否正在占用端口 */
    routeListening: () => boolean;
  };
  onUsage?: (e: UsageEvent) => void;
  /** 调试追踪目录（用量面板「调试模式」打开时才有，§14） */
  traceDir?: () => string | undefined;
  /** 环境变量提供的供应商（DEEPSEEK_API_KEY 等，ai-runtime 的 llmProvidersFromEnv） */
  envProviders?: () => EnvProviderEntry[];
  /** 按预设 id 取厂商差异（ai-runtime presets） */
  presetQuirks?: (presetId: string | undefined) => ProviderQuirks | undefined;
  /** 长上下文的计价（用量服务的价格表：内置 + 同步 + 自定义），界面提示「超过标准窗口按多少计费」 */
  longContextPrice?: (model: string) => LongContextPrice | undefined;
  /** 按预设 id 取预设整理的模型元数据（ai-runtime presets 的 modelMeta，§12.7.2） */
  presetModels?: (presetId: string | undefined) => readonly PresetModelMeta[] | undefined;
  /** 测试注入：疑似不可用的协议用它确认 */
  detectImpl?: typeof detect;
  /** 测试注入：环境变量（NOMI_ROUTE_PLAN）；默认 process.env */
  env?: NodeJS.ProcessEnv;
  broadcast?: (channel: string, payload: unknown) => void;
}

/** 同步到的模型目录至少要有这么多条，否则视为异常响应 */
const MIN_SYNCED_MODELS = 100;

export class GatewayService {
  readonly store: GatewayStore;
  /** 第三方标签的进程级令牌与绑定（§6.7） */
  readonly tabs: TabTokens;
  private readonly proc: GatewayProcess;
  /** 最近隐藏的密钥（只有元数据） */
  private readonly privacyLog: PrivacyLog;

  constructor(private readonly d: GatewayServiceDeps) {
    this.privacyLog = new PrivacyLog(path.join(d.root, 'privacy-log.json'));
    this.store = new GatewayStore({
      file: path.join(d.root, 'store.json'),
      cipher: d.cipher,
      logger: d.logger,
      presetQuirks: d.presetQuirks,
      presetModels: d.presetModels,
    });
    this.proc =
      d.process ??
      new GatewayProcess({
        logger: d.logger,
        onUsage: (e) => {
          this.notePrivacy(e);
          d.onUsage?.(e);
        },
        onLearn: (e) => void this.learn(e),
        onKeyStatus: (e) => this.keyStatus(e),
        onStatus: () => this.changed(),
      });
    this.tabs = new TabTokens({ send: (m) => this.proc.send(m), logger: d.logger });
    this.proc.bindTabs({ ack: (m) => this.tabs.onAck(m), spawn: () => this.tabs.replay() });
  }

  /** 启动：迁移（只一次）→ 归档残留旧文件 → 令牌 → 拉起网关 */
  init(): void {
    if (!this.store.exists() && this.d.legacy) {
      try {
        migrateLegacy(
          this.store,
          {
            nomiFile: this.d.legacy.nomiFile,
            cliRoot: this.d.legacy.cliRoot,
            nomiCipher: this.d.cipher,
            cliDecrypt: this.d.legacy.cliDecrypt,
            normalizeNomi: this.d.legacy.normalizeNomi,
          },
          this.d.logger,
        );
      } catch (e) {
        // 迁移失败不阻塞启动：保留空存储，旧文件原样，用户可在「模型」页重新导入
        this.d.logger.warn('gateway migration failed', e);
      }
    }
    const normalized = this.normalizeCliAssignments();
    const keyed = this.store.ensurePrivacyKey();
    if (this.store.ensureClients() || keyed || normalized || !this.store.exists())
      this.store.save();
    this.archiveLeftoverLegacy();
    // 上次同步到的模型目录（models.dev）：主进程的元数据解析先用上；网关进程按 catalogFile 自己读
    setCatalogOverlay(readCatalogFile(this.catalogFile));
    this.push();
  }

  /* ------------------------------ 模型数据同步（§12.7.2） ------------------------------ */

  private get catalogFile(): string {
    return path.join(this.d.root, 'catalog-sync.json');
  }

  /** 已有同步到的模型目录（没有时模型数据同步要强制完整下载，不能被 304 跳过） */
  hasCatalogSync(): boolean {
    return catalogOverlayVersion() !== null;
  }

  /**
   * 模型数据同步下载到的 models.dev api.json（用量服务的 PriceSync 转交）→ 生成模型目录覆盖层：
   * 写进 userData、主进程立即生效、推配置让网关进程重读，并通知界面刷新生效值。
   * 条目明显过少（异常响应）时不采用，保留原有目录。
   */
  applyModelsData(api: unknown): Promise<void> {
    const { fromFallback: _f, ...doc } = buildCatalog(api, new Date().toISOString().slice(0, 10));
    void _f;
    if (Object.keys(doc.models).length < MIN_SYNCED_MODELS) {
      this.d.logger.warn('models data sync: too few models, keeping the current catalog', {
        count: Object.keys(doc.models).length,
      });
      return Promise.resolve();
    }
    fs.mkdirSync(this.d.root, { recursive: true });
    // 内存先更新；磁盘异步落盘，避免 Windows 占用重试卡住主进程（#154）
    setCatalogOverlay(doc);
    this.push();
    this.changed();
    return writePrivateFileAtomicAsync(this.catalogFile, JSON.stringify(doc)).catch((e) => {
      this.d.logger.warn('models catalog write failed', { error: String(e) });
    });
  }

  /**
   * 已迁移（或网关已有供应商）时，把仍留在磁盘上的 ai-providers.json 与各 CLI 的 store.json
   * 改名为 `.migrated` 后缀，避免运行时再读旧双轨存储。空且未迁移时不动，以免误归档未导入的配置。
   */
  private archiveLeftoverLegacy(): void {
    if (!this.d.legacy) return;
    const snap = this.store.snapshot();
    if (!snap.migratedFrom && snap.providers.length === 0) return;
    const left = legacyFileCandidates(this.d.legacy).filter((f) => fs.existsSync(f));
    if (!left.length) return;
    archiveLegacyFiles(left, this.d.logger);
  }

  private legacyRevoke: GatewayStateView['legacyRevoke'];

  /** 撤销旧全局配置的结果：撤销没全部成功时继续接受旧路由令牌（§10.2），并在「模型」页提示 */
  setLegacyRevoke(r: { revoked: string[]; failed: Array<{ kind: string; error: string }> }): void {
    this.legacyRevoke =
      r.revoked.length || r.failed.length ? { revoked: r.revoked, failed: r.failed } : undefined;
    this.push();
    this.changed();
  }

  /** 推给网关进程的快照 */
  runtimeConfig(): GatewayConfig {
    const cfg = this.config();
    // 会话归属表由网关进程自己读写（§11.4）
    cfg.sessionsFile = path.join(this.d.root, 'sessions.json');
    if (this.hasCatalogSync()) cfg.catalogFile = this.catalogFile;
    const traceDir = this.d.traceDir?.();
    if (traceDir) cfg.traceDir = traceDir;
    // 路由计划默认 active（按新计划选上游协议）；NOMI_ROUTE_PLAN=shadow 可回滚到影子模式（§6.9.4）
    const rp = (this.d.env ?? process.env).NOMI_ROUTE_PLAN;
    if (rp === 'shadow') cfg.routePlan = 'shadow';
    else cfg.routePlan = 'active';
    // 旧路由占着端口时先用临时端口
    if (this.d.legacy?.routeListening()) cfg.port = 0;
    return cfg;
  }

  /** 含环境变量供应商的快照（路由、Nomi 对话、编程助手可选模型共用） */
  private config(): GatewayConfig {
    const env = this.envRuntime();
    const cfg = this.store.runtimeConfig({
      legacyToken: this.d.legacy?.token() ?? undefined,
      envProviders: env,
    });
    // 环境变量里配的本机地址（如 OLLAMA_BASE_URL）是用户自己设的：视为已确认（§15）
    const hosts = new Set(cfg.allowedPrivateHosts ?? []);
    for (const p of env)
      for (const u of Object.values(p.urls))
        if (u && privateUrl(u)) {
          const hp = hostPortOf(u);
          if (hp) hosts.add(hp);
        }
    cfg.allowedPrivateHosts = [...hosts];
    return cfg;
  }

  /** 环境变量提供的供应商（只读，id 加 env- 前缀，不与用户添加的冲突） */
  private envRuntime(): RuntimeProvider[] {
    return (this.d.envProviders?.() ?? []).map((e) => ({
      id: `env-${e.id}`,
      name: e.name,
      enabled: true,
      urls: { [e.wire]: e.url },
      keys: [{ id: 'env', value: e.key ?? '', enabled: true }],
      models: e.model ? [{ id: e.model, enabled: true }] : [],
    }));
  }

  /**
   * 第三方模型引用自带供应商，不能与「新标签默认」的官方 / 其它供应商来源分离保存。
   * 旧版本可能已经留下不一致的组合，启动时统一修正一次。
   */
  private normalizeCliAssignments(): boolean {
    const data = this.store.snapshot();
    let changed = false;
    for (const id of CLIENT_IDS) {
      if (id === 'nomi') continue;
      const client = data.clients[id];
      if (!client) continue;
      const main = client.models.main?.trim();
      if (main && client.newTabSource !== 'thirdParty') {
        client.newTabSource = 'thirdParty';
        client.newTabAccountId = undefined;
        changed = true;
      } else if (!main && client.newTabSource === 'thirdParty') {
        client.newTabSource = 'official';
        changed = true;
      }
    }
    if (changed) this.store.replace(data);
    return changed;
  }

  private push(): void {
    this.proc.apply(this.runtimeConfig());
  }

  /** 外部设置变化（如调试模式开关）后重新推一次配置 */
  refresh(): void {
    this.push();
  }

  private commit(): void {
    this.store.save();
    this.push();
    this.changed();
  }

  private readonly listeners = new Set<() => void>();

  /** 主进程内订阅（托盘等）：存储或网关状态变化时回调 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.d.broadcast?.('ai:gateway:changed', null);
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        this.d.logger.warn('gateway change listener failed', e);
      }
    }
  }

  status(): GatewayStatus {
    return this.proc.getStatus();
  }

  whenReady(timeoutMs?: number): Promise<boolean> {
    return this.proc.whenReady(timeoutMs);
  }

  /** 网关当前地址与某个客户端的令牌（主进程内部用：生成 CLI 注入参数、Nomi 对话），不经 IPC */
  endpoint(client: ClientId): { url: string; token: string } | null {
    const s = this.proc.getStatus();
    const token = this.store.clientToken(client);
    return s.state === 'running' && token ? { url: s.url, token } : null;
  }

  /**
   * Nomi 对话按角色走网关（§12.5）：provider/model 取 clients.nomi（tools / summary 为空时跟随 main），
   * 入口协议取这个模型「自己会选的协议」，网关那一侧同协议透传。网关没在运行或没配模型时返回 null。
   * receiver 是工具结果真正的接收者：首选与回退里只要有一个不在本机 / 局域网，就报那一个（宁可当云端）。
   */
  nomiRoute(role: NomiRole): {
    baseURL: string;
    token: string;
    model: string;
    protocol: 'openai-chat' | 'openai-responses' | 'anthropic';
    receiver: { id: string; baseURL: string };
  } | null {
    const ep = this.endpoint('nomi');
    const picked = this.nomiPick(role);
    if (!ep || !picked) return null;
    const receiver = { id: picked.receiver.providerId, baseURL: picked.receiver.url };
    // AI SDK 没有 Gemini 实现：走 Chat，由网关转换
    if (picked.wire === 'messages')
      return {
        baseURL: ep.url,
        token: ep.token,
        model: picked.publicModel,
        protocol: 'anthropic',
        receiver,
      };
    return {
      baseURL: `${ep.url}/v1`,
      token: ep.token,
      model: picked.publicModel,
      protocol: picked.wire === 'responses' ? 'openai-responses' : 'openai-chat',
      receiver,
    };
  }

  /* ------------------------------ 编程助手（§12） ------------------------------ */

  /** 新标签默认用哪种来源、第三方时用哪个模型、官方时用哪个账号（clients.<cli>，§12） */
  cliDefaults(kind: AgentKind): {
    source: 'official' | 'thirdParty';
    model: string | null;
    accountId: string | null;
  } {
    const c = this.store.snapshot().clients[kind];
    const model = c?.models.main ?? null;
    return {
      source: c?.newTabSource === 'thirdParty' && model ? 'thirdParty' : 'official',
      model,
      // 账号选择只在官方来源时有意义；切到第三方时忽略
      accountId: c?.newTabSource === 'thirdParty' ? null : (c?.newTabAccountId ?? null),
    };
  }

  /** 第三方标签可选的模型（启用的供应商里启用的模型，`供应商/模型`） */
  cliModels(): Array<{
    ref: string;
    provider: string;
    label: string;
    reasoning?: boolean;
    vision?: boolean;
    ctx?: number;
  }> {
    return [...this.store.providers(), ...this.envViews()]
      .filter((p) => p.enabled)
      .flatMap((p) =>
        p.models
          .filter((m) => m.enabled && m.toolCalling !== false)
          .map((m) => {
            const meta = this.modelMetaOf(`${p.id}/${m.id}`);
            return {
              ref: `${p.id}/${m.id}`,
              provider: p.name,
              label: m.label ?? m.id,
              ...(meta?.reasoning !== undefined ? { reasoning: meta.reasoning } : {}),
              ...(meta?.vision !== undefined ? { vision: meta.vision } : {}),
              ...(meta && meta.source !== 'default' ? { ctx: meta.ctx } : {}),
            };
          }),
      );
  }

  /**
   * 按 `供应商/模型` 取生效元数据（§12.7.2：用户 > 预设 > 模型列表 > 内置目录 > 默认值）。
   * 编程助手启动注入、终端命令、模型选择器共用；供应商不存在时返回 undefined。
   */
  modelMetaOf(ref: string, opts: { longContext?: boolean } = {}): ResolvedModelMeta | undefined {
    const i = ref.indexOf('/');
    if (i <= 0) return undefined;
    const pid = ref.slice(0, i);
    const mid = ref.slice(i + 1);
    const p = this.store.providers().find((x) => x.id === pid);
    if (p) return this.store.modelMeta(p, mid, opts);
    // 环境变量供应商的 id 是 env-<预设 id>
    const env = this.envViews().find((x) => x.id === pid);
    return env
      ? this.store.modelMeta({ presetId: pid.slice(4), models: env.models }, mid, opts)
      : undefined;
  }

  /**
   * 编程助手启动注入用的元数据：生效值加上显示名。
   * longContext：这个标签对长上下文的选择（只对标签的主模型给；不给 = 按模型默认）
   */
  agentMeta(ref: string, opts: { longContext?: boolean } = {}): ModelMeta | undefined {
    const meta = this.modelMetaOf(ref, opts);
    if (!meta) return undefined;
    const i = ref.indexOf('/');
    const pid = ref.slice(0, i);
    const p = [...this.store.providers(), ...this.envViews()].find((x) => x.id === pid);
    const m = p?.models.find((x) => x.id === ref.slice(i + 1));
    return {
      label: m?.label ?? ref.slice(i + 1),
      ...(p ? { provider: p.name } : {}),
      ctx: meta.ctx,
      maxOutput: meta.maxOutput,
      ...(meta.reasoning !== undefined ? { reasoning: meta.reasoning } : {}),
      ...(meta.vision !== undefined ? { vision: meta.vision } : {}),
    };
  }

  /** 这个标签的进程级私有目录（Grok 私有 GROK_HOME、dsh 叠加文件等） */
  private agentDir(kind: AgentKind, tabId: string): string {
    return path.join(this.d.root, 'agents', kind, tabId.replace(/[^\w-]/g, '_'));
  }

  /**
   * 第三方会话的进程级注入（环境变量、参数、要剔除的继承变量）。网关没在运行时返回 null，
   * 调用方报错而不是悄悄走官方。dir：这个标签的私有目录（Grok 私有 GROK_HOME、dsh 叠加文件）。
   */
  cliLaunch(
    kind: AgentKind,
    tabId: string,
    model: string,
    /** longContext：标签对长上下文的选择；不给 = 按模型默认（窗口进注入参数，变了会重启进程） */
    opts: { tabBound?: boolean; longContext?: boolean } = {},
  ): AgentLaunch | null {
    // 按标签令牌启动（tabBound）且插件支持 gateway 方式换模型（清单 clientSpec.placeholderModel，
    // 如 Grok 的 nomi）：配置里写占位名，真实模型只在绑定里，换模型不用重启（§6.7）。
    // 同一个标签的同步 / 异步两条路径必须写出同一份配置，否则后写的会覆盖先写的
    const placeholder = opts.tabBound ? placeholderModelOf(kind) : undefined;
    const ep = this.endpoint(kind);
    if (!ep) return null;
    return agentLaunch(kind, {
      url: ep.url,
      token: ep.token,
      model,
      // 标签的长上下文选择只作用于它的主模型；档位 / 子代理等其它模型按各自默认
      metaOf: (ref) =>
        this.agentMeta(
          ref,
          ref === model && opts.longContext !== undefined ? { longContext: opts.longContext } : {},
        ),
      catalog: this.cliModels().map((m) => m.ref),
      models: this.store.snapshot().clients[kind]?.models ?? {},
      dir: this.agentDir(kind, tabId),
      ...(placeholder ? { placeholder } : {}),
    });
  }

  /**
   * 同 cliLaunch，但给这个进程签一个标签令牌（`nomi-tab-`）并先在网关登记绑定（§6.7）：
   * 网关按绑定解析这个标签的模型 / 思考深度，请求日志带标签 id。每次启动进程（含回收后重启、
   * 重启型换模型）调一次，得到新代次；进程退出或标签关闭时调 releaseTab。
   * 网关没在运行或不确认绑定时 reject，调用方报错而不是带着无效令牌启动。
   */
  async cliLaunchForTab(
    kind: AgentKind,
    tabId: string,
    model: string,
    effort?: string,
    longContext?: boolean,
  ): Promise<(AgentLaunch & { generation: number }) | null> {
    const ep = this.endpoint(kind);
    const launch = this.cliLaunch(kind, tabId, model, {
      tabBound: true,
      ...(longContext !== undefined ? { longContext } : {}),
    });
    if (!ep || !launch) return null;
    const reg = await this.tabs.register({
      client: kind,
      tabId,
      models: { ...this.store.snapshot().clients[kind]?.models, main: model },
      ...(effort ? { effort } : {}),
    });
    const swap = (v: string) => v.split(ep.token).join(reg.token);
    return {
      ...launch,
      env: Object.fromEntries(Object.entries(launch.env).map(([k, v]) => [k, swap(v)])),
      args: launch.args.map(swap),
      generation: reg.generation,
    };
  }

  /** 第三方标签的进程退出 / 标签关闭：作废它的令牌 */
  releaseTab(kind: AgentKind, tabId: string, generation?: number): void {
    this.tabs.remove(kind, tabId, generation);
  }

  /**
   * 标签关闭后回收它的进程级私有目录。里面只有 Nomi 生成的配置文件和指向用户 CLI 目录的软链，
   * 令牌只在子进程环境里、不落盘。rm 不跟随软链，用户的 ~/.grok 等不受影响。
   */
  releaseAgent(kind: AgentKind, tabId: string): void {
    try {
      fs.rmSync(this.agentDir(kind, tabId), { recursive: true, force: true });
    } catch (e) {
      this.d.logger.warn('gateway agent dir cleanup failed', e);
    }
  }

  /**
   * 这个编程助手会话是否经网关跑过（网关的会话归属表，§11.4）。用于打开历史会话时推断来源（#90）。
   * 只有 Claude 的会话键带 CLI 会话 id（x-claude-code-session-id）；查不到（含 30 天淘汰）返回 false。
   */
  servedSession(kind: AgentKind, sessionId: string): boolean {
    return this.sessionOwner(kind, sessionId) !== null;
  }

  /** 网关最后一次服务这个会话的模型 `供应商/模型`（会话归属表里记的）；没有记录返回 undefined */
  servedSessionRef(kind: AgentKind, sessionId: string): string | undefined {
    const model = (this.sessionOwner(kind, sessionId) as { model?: unknown } | null)?.model;
    return typeof model === 'string' && model.includes('/') ? model : undefined;
  }

  private sessionOwner(kind: AgentKind, sessionId: string): unknown {
    // eslint-disable-next-line nomi/no-cli-literal -- 只有 Claude 的会话键带 CLI 会话 id（x-claude-code-session-id）
    if (kind !== 'claude' || !sessionId) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.d.root, 'sessions.json'), 'utf8')) as {
        sessions?: Array<[string, unknown]>;
      };
      const key = `claude:cc:${sessionId}`;
      const hit = (raw.sessions ?? []).find(([k]) => k === key);
      return hit ? (hit[1] ?? {}) : null;
    } catch {
      return null;
    }
  }

  /** 官方会话的环境：剔除指向网关的残留变量 */
  officialEnv<T extends Record<string, string | undefined>>(env: T): T {
    const s = this.proc.getStatus();
    if (s.state !== 'running') return env;
    const tokens = CLIENT_IDS.map((c) => this.store.clientToken(c) ?? '').filter(Boolean);
    return stripGatewayLeftovers(env, { url: s.url, tokens }) as T;
  }

  /** 某个角色当前用的供应商与模型（桌面工具判断本地 / 云端、托盘与屏幕面板显示）；不要求网关在运行 */
  nomiProvider(
    role: NomiRole,
  ): { id: string; name: string; baseURL: string; model: string } | null {
    const picked = this.nomiPick(role);
    if (!picked) return null;
    const head = picked.upstreams[0]!;
    return {
      id: head.providerId,
      name: head.name,
      // 回退里有云端上游时报云端地址：隐私判断宁严勿松
      baseURL: picked.receiver.url,
      model: picked.publicModel.slice(head.providerId.length + 1),
    };
  }

  /** 按网关供应商 id 查名字与地址（不含 Key）；地址里有云端的就报云端 */
  providerInfo(id: string): { id: string; name: string; baseURL: string } | null {
    const p = this.store.providers().find((x) => x.id === id || x.aliases?.includes(id));
    if (!p) return null;
    const urls = Object.values(p.urls).filter((u): u is string => Boolean(u));
    return { id: p.id, name: p.name, baseURL: urls.find((u) => !privateUrl(u)) ?? urls[0] ?? '' };
  }

  /**
   * 非对话用途（知识库向量、云端语音识别）的连接信息：只列有 OpenAI 兼容（Chat）地址的供应商。
   * 只在主进程内使用，绝不发给渲染进程。
   */
  credentials(id: string): { id: string; name: string; baseURL: string; apiKey?: string } | null {
    const p = this.store.providers().find((x) => x.id === id && x.enabled);
    if (!p?.urls.chat) return null;
    // 只用 Chat 协议能用的 Key（未限定协议或限定为 chat），与网关路由的 wiresFor 一致；
    // 限定给 messages 等其它协议的 Key 不发到 Chat 地址（#95）
    const key = p.keys
      .filter((k) => k.enabled && (!k.wire || k.wire === 'chat'))
      .map((k) => this.store.decrypt(k.enc, k.encryption))
      .find((v): v is string => Boolean(v));
    return { id: p.id, name: p.name, baseURL: p.urls.chat, ...(key ? { apiKey: key } : {}) };
  }

  /** 同上，列表（不含 Key） */
  listOpenAiCompatible(): Array<{ id: string; name: string; baseURL: string }> {
    return this.store
      .providers()
      .filter((p) => p.enabled && p.urls.chat)
      .map((p) => ({ id: p.id, name: p.name, baseURL: p.urls.chat! }));
  }

  private nomiPick(role: NomiRole) {
    const models = this.store.snapshot().clients.nomi?.models;
    const cfg = this.config();
    // 没给 Nomi 对话分配模型时，用第一个环境变量供应商的默认模型
    const env = cfg.providers.find((p) => p.id.startsWith('env-') && p.models[0]);
    const main = models?.main ?? (env ? `${env.id}/${env.models[0]!.id}` : undefined);
    if (!main) return null;
    const ref =
      (role === 'agent-tools' ? models?.tools : role === 'summary' ? models?.summary : undefined) ??
      main;
    const picked = preferredWire(cfg, 'nomi', ref);
    if (!picked?.upstreams.length) return null;
    const receiver = picked.upstreams.find((u) => !privateUrl(u.url)) ?? picked.upstreams[0]!;
    return { ...picked, receiver };
  }

  /**
   * 编程助手标签的辅助请求（右栏「生成提交信息」在 Nomi 自己没配模型时用）：按这个编程助手在「模型」页的
   * 辅助档 → Haiku 档 → 小模型 → 标签选的模型 → 主模型，取第一个网关能路由的。以 nomi 客户端经网关发出，
   * 所以照样受外发保护。网关没在运行或都路由不了时 null。
   */
  helperRoute(
    kind: string,
    tabModel: string | null,
  ): { model: string; receiver: { id: string; name: string; local: boolean } } | null {
    if (!this.endpoint('nomi')) return null;
    const m = this.store.snapshot().clients[kind as ClientId]?.models;
    const cfg = this.config();
    for (const ref of [m?.summary, m?.tiers?.haiku, m?.small, tabModel, m?.main]) {
      if (!ref) continue;
      const picked = preferredWire(cfg, 'nomi', ref);
      if (!picked?.upstreams.length) continue;
      const cloud = picked.upstreams.find((u) => !privateUrl(u.url));
      const u = cloud ?? picked.upstreams[0]!;
      return {
        model: picked.publicModel,
        receiver: { id: u.providerId, name: u.name, local: !cloud },
      };
    }
    return null;
  }

  /** 经网关发一次非流式的 Chat 请求（入口协议固定 Chat，网关按上游转换），返回正文 */
  async helperComplete(
    model: string,
    messages: Array<{ role: string; content: string }>,
    signal: AbortSignal,
  ): Promise<string> {
    const ep = this.endpoint('nomi');
    if (!ep) throw new Error(tr('electron.common.ai-service-not-ready'));
    const res = await fetch(`${ep.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
    try {
      const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const c = j.choices?.[0]?.message?.content;
      return typeof c === 'string' ? c : '';
    } catch {
      return '';
    }
  }

  /* ------------------------------ 渲染进程视图 ------------------------------ */

  state(): GatewayStateView {
    const data = this.store.snapshot();
    return {
      status: this.proc.getStatus(),
      providers: [
        ...data.providers.map((p) => ({
          ...p,
          models: p.models.map((m) =>
            withEffective(m, this.store.modelMeta(p, m.id), this.d.longContextPrice),
          ),
          keys: p.keys.map(({ enc, encryption, ...k }) => ({
            ...k,
            decryptable: this.store.decrypt(enc, encryption) !== null,
          })),
          ...(hasLearned(data.learned[p.id]) ? { learned: data.learned[p.id] } : {}),
        })),
        ...this.envViews().map((p) => ({
          ...p,
          models: p.models.map((m) =>
            withEffective(
              m,
              this.store.modelMeta({ presetId: p.id.slice(4), models: [m] }, m.id),
              this.d.longContextPrice,
            ),
          ),
        })),
      ],
      clients: Object.fromEntries(
        CLIENT_IDS.flatMap((id) => {
          const c = data.clients[id];
          return c
            ? [
                [
                  id,
                  {
                    models: c.models,
                    ...(c.newTabSource ? { newTabSource: c.newTabSource } : {}),
                    ...(c.newTabAccountId ? { newTabAccountId: c.newTabAccountId } : {}),
                  },
                ],
              ]
            : [];
        }),
      ),
      allowedPrivateHosts: data.allowedPrivateHosts,
      port: data.port,
      strictParams: data.strictParams === true,
      maxRequestBodyBytes: clampMaxRequestBodyBytes(data.maxRequestBodyBytes ?? 32 * 1024 * 1024),
      privacyMode: data.privacyMode !== false,
      privacy: {
        strict: data.privacyStrict === true,
        local: data.privacyLocal === true,
        shape: data.privacyShape === true,
        actions: { ...(data.privacyActions ?? {}) },
        secrets: (data.privacySecrets ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          masked: s.masked,
        })),
        allow: (data.privacyAllow ?? []).map((a) => ({ ...a })),
      },
      ...(data.migratedFrom ? { migratedFrom: data.migratedFrom } : {}),
      ...(data.recentNomi?.length ? { recentNomi: data.recentNomi } : {}),
      catalog: {
        models: catalogSize(),
        version: catalogOverlayVersion() ?? CATALOG_VERSION,
        synced: this.hasCatalogSync(),
      },
      ...(this.legacyRevoke ? { legacyRevoke: this.legacyRevoke } : {}),
    };
  }

  /** 环境变量供应商在「模型」页的只读视图（Key 只给掩码） */
  private envViews(): ProviderView[] {
    return (this.d.envProviders?.() ?? []).map((e) => ({
      id: `env-${e.id}`,
      name: e.name,
      enabled: true,
      urls: { [e.wire]: e.url },
      keys: e.key
        ? [{ id: 'env', name: e.keyEnv, masked: maskKey(e.key), enabled: true, decryptable: true }]
        : [],
      models: e.model ? [{ id: e.model, enabled: true }] : [],
      modelsSource: 'manual' as const,
      source: 'env' as const,
      createdAt: 0,
      updatedAt: 0,
    }));
  }

  /* ------------------------------ 修改 ------------------------------ */

  upsertProvider(input: ProviderInput): ProviderView {
    const name = input.name.trim();
    if (!name) throw new Error(tr('electron.common.name-can-t-be-empty'));
    const now = Date.now();
    const prev = input.id ? this.store.providers().find((p) => p.id === input.id) : undefined;
    if (input.id && !prev) throw new Error(tr('electron.common.provider-not-found'));
    if (prev?.source === 'env')
      throw new Error(tr('electron.common.providers-from-environment-variables-are-read-only'));
    const existing = new Map((prev?.keys ?? []).map((k) => [k.id, k]));
    const kept: GatewayKey[] = input.keys
      ? input.keys.flatMap((k) => {
          const old = existing.get(k.id);
          return old
            ? [
                withLimits(
                  {
                    ...old,
                    enabled: k.enabled,
                    ...(k.name !== undefined ? { name: k.name } : {}),
                    wire: k.wire,
                  },
                  k,
                ),
              ]
            : [];
        })
      : (prev?.keys ?? []);
    const added = (input.newKeys ?? [])
      .map((k) => ({ ...k, value: k.value.trim() }))
      .filter((k) => k.value)
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
      // 名称留空时界面按顺序显示「主 Key / 备用 Key N」（随界面语言翻译）
      .map((k) => ({
        key: withLimits(
          {
            ...this.store.makeKey(k.value, { name: k.name, wire: k.wire }),
            enabled: k.enabled ?? true,
          },
          k,
        ),
        position: k.position,
      }));
    const keys = [...kept];
    for (const { key, position } of added) {
      const at = Number.isInteger(position)
        ? Math.max(0, Math.min(position!, keys.length))
        : keys.length;
      keys.splice(at, 0, key);
    }
    const p: GatewayProvider = {
      ...(prev ?? { createdAt: now, source: 'user' as const, modelsSource: 'manual' as const }),
      id: prev?.id ?? this.store.uniqueProviderId(input.presetId ?? name),
      name,
      ...(input.presetId ? { presetId: input.presetId } : {}),
      enabled: input.enabled ?? prev?.enabled ?? true,
      urls: Object.fromEntries(
        Object.entries({ ...prev?.urls, ...input.urls })
          .filter(([, u]) => u?.trim())
          .map(([w, u]) => [w, u!.trim()]),
      ) as GatewayProvider['urls'],
      keys,
      // 界面回传的条目带着显示用的生效值（effective），不落盘
      models: input.models?.map(({ effective: _e, ...m }: ModelView) => m) ?? prev?.models ?? [],
      ...(input.modelMap ? { modelMap: input.modelMap } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent || undefined } : {}),
      ...(input.fallback ? { fallback: input.fallback } : {}),
      ...(input.detected ? { detected: input.detected } : {}),
      ...(input.quirks ? { quirks: input.quirks } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    } as GatewayProvider;
    this.bumpLearn(p.id);
    this.store.upsertProvider(p);
    this.commit();
    return this.state().providers.find((x) => x.id === p.id)!;
  }

  removeProvider(id: string): void {
    const p = this.store.providers().find((x) => x.id === id);
    if (!p) return;
    if (p.source === 'env')
      throw new Error(tr('electron.common.providers-from-environment-variables-are-read-only'));
    this.bumpLearn(id);
    this.store.removeProvider(id);
    this.commit();
  }

  setAssignment(
    client: ClientId,
    patch: {
      models?: ClientModels;
      newTabSource?: 'official' | 'thirdParty';
      newTabAccountId?: string | null;
    },
  ): void {
    const normalized = this.normalizeAssignmentPatch(client, patch);
    this.store.setClient(client, normalized);
    const main = normalized.models?.main;
    if (client === 'nomi' && main) {
      const data = this.store.snapshot();
      data.recentNomi = [main, ...(data.recentNomi ?? []).filter((r) => r !== main)].slice(0, 5);
      this.store.replace(data);
    }
    this.commit();
  }

  /** IPC / 主进程调用也走同一条联动规则，避免只靠渲染进程保证状态一致。 */
  private normalizeAssignmentPatch(
    client: ClientId,
    patch: {
      models?: ClientModels;
      newTabSource?: 'official' | 'thirdParty';
      newTabAccountId?: string | null;
    },
  ) {
    if (client === 'nomi') return patch;
    const hasMain = Boolean(
      patch.models && Object.prototype.hasOwnProperty.call(patch.models, 'main'),
    );
    const main = patch.models?.main;
    if (hasMain) {
      if (main) {
        return {
          ...patch,
          newTabSource: 'thirdParty' as const,
          newTabAccountId: null,
        };
      }
      // GatewayStore 用 undefined 表示从合并后的 models 中清除字段；渲染进程的 IPC
      // 仍可传 null，进入这里后统一转换成可持久化的形状。
      return {
        ...patch,
        newTabSource: 'official' as const,
        models: { ...patch.models, main: undefined },
      };
    }
    if (patch.newTabSource === 'official')
      return { ...patch, models: { ...patch.models, main: undefined } };
    return patch;
  }

  resetToken(client: ClientId): void {
    this.store.resetToken(client);
    this.commit();
  }

  /**
   * 供应商学习状态的代次：清除学习、改 / 删供应商时加一。异步探测回来时代次变了就作废，
   * 不把旧地址 / 旧 Key 的结论写回、也不复活已清除的状态（#96）
   */
  private readonly learnGen = new Map<string, number>();
  private bumpLearn(providerId: string): void {
    this.learnGen.set(providerId, (this.learnGen.get(providerId) ?? 0) + 1);
  }

  /** 网关全局选项：严格模式、请求体上限、隐私模式等 */
  setOptions(patch: GatewayOptionsPatch): GatewayStateView {
    let changed = false;
    const data = this.store.snapshot();
    if (typeof patch.strictParams === 'boolean') {
      if (patch.strictParams) data.strictParams = true;
      else delete data.strictParams;
      changed = true;
    }
    if (typeof patch.maxRequestBodyBytes === 'number') {
      data.maxRequestBodyBytes = clampMaxRequestBodyBytes(patch.maxRequestBodyBytes);
      changed = true;
    }
    // 隐私模式默认开：打开时去掉字段，只有关掉才写 false
    if (typeof patch.privacyMode === 'boolean') {
      if (patch.privacyMode) delete data.privacyMode;
      else data.privacyMode = false;
      changed = true;
    }
    // 三个细项默认关：打开才写 true
    for (const k of ['privacyStrict', 'privacyLocal', 'privacyShape'] as const) {
      if (typeof patch[k] !== 'boolean') continue;
      if (patch[k]) data[k] = true;
      else delete data[k];
      changed = true;
    }
    if (changed) {
      this.store.replace(data);
      this.commit();
    }
    return this.state();
  }

  /* ------------------------------ 隐私模式（docs/design/secret-privacy.md §9、§12） ------------------------------ */

  /**
   * 「试一试」：一段文字按现在的设置会变成什么。主进程直接算（previewPrivacy 是纯函数、一次性存储），
   * 已知原文与网关进程里的一致（第三方 Key、客户端令牌、自定义密钥），不登记已见值
   */
  previewPrivacy(text: unknown): { text: string; hits: RedactionHit[] } {
    const s = typeof text === 'string' ? text.slice(0, PREVIEW_MAX) : '';
    const cfg = this.runtimeConfig();
    return previewPrivacy(s, { ...cfg.privacy!, known: knownSecrets(cfg) });
  }

  /** 网关用量事件里的命中记录进「最近隐藏的密钥」 */
  notePrivacy(e: UsageEvent): void {
    this.privacyLog.note(e);
  }

  privacyLogEntries(): PrivacyLogEntry[] {
    return this.privacyLog.list();
  }

  /** 某类值找到之后怎么处理：mask（默认）/ warn（只提醒）/ block（拦截） */
  setPrivacyAction(kind: unknown, action: unknown): GatewayStateView {
    if (!PRIVACY_KINDS.includes(kind as (typeof PRIVACY_KINDS)[number]))
      throw new Error(tr('electron.common.privacy-unknown-secret-kind'));
    if (action !== 'mask' && action !== 'warn' && action !== 'block')
      throw new Error(tr('electron.common.privacy-unknown-secret-action'));
    const data = this.store.snapshot();
    const actions = { ...(data.privacyActions ?? {}) };
    if (action === 'mask') delete actions[kind as string];
    else actions[kind as string] = action;
    if (Object.keys(actions).length) data.privacyActions = actions;
    else delete data.privacyActions;
    this.store.replace(data);
    this.commit();
    return this.state();
  }

  /** 登记自定义密钥：之后任何请求里出现这个原文都按 CUSTOM 遮 */
  addPrivacySecret(input: unknown): GatewayStateView {
    const o = (input ?? {}) as { name?: unknown; value?: unknown };
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 40) : '';
    const value = typeof o.value === 'string' ? o.value.trim() : '';
    if (!name) throw new Error(tr('electron.common.name-can-t-be-empty'));
    if (value.length < MIN_KNOWN || value.length > 4096)
      throw new Error(tr('electron.common.privacy-secret-length-invalid', MIN_KNOWN));
    const data = this.store.snapshot();
    const list = data.privacySecrets ?? [];
    if (list.length >= 100) throw new Error(tr('electron.common.privacy-too-many-secrets'));
    if (list.some((s) => this.store.decrypt(s.enc, s.encryption) === value))
      throw new Error(tr('electron.common.privacy-secret-already-added'));
    const enc = this.store.encrypt(value);
    data.privacySecrets = [
      ...list,
      {
        id: `s-${randomUUID().slice(0, 8)}`,
        name,
        enc: enc.enc,
        encryption: enc.encryption,
        masked: maskKey(value),
      },
    ];
    this.store.replace(data);
    this.commit();
    return this.state();
  }

  removePrivacySecret(id: unknown): GatewayStateView {
    const data = this.store.snapshot();
    const list = data.privacySecrets ?? [];
    const next = list.filter((s) => s.id !== id);
    if (next.length !== list.length) {
      if (next.length) data.privacySecrets = next;
      else delete data.privacySecrets;
      this.store.replace(data);
      this.commit();
    }
    return this.state();
  }

  /**
   * 加进「从不脱敏」：从「最近隐藏的密钥」里点「这不是密钥」时给标记与辨认信息；
   * 手动添加时给原文，这里算出标记后原文就丢掉，不落盘
   */
  addPrivacyAllow(input: unknown): GatewayStateView {
    const o = (input ?? {}) as Record<string, unknown>;
    let entry: { tag: string; kind: string; len: number; head: string };
    if (typeof o.value === 'string' && o.value.trim()) {
      const v = o.value.trim().slice(0, 256);
      entry = {
        tag: allowTagOf(this.store.privacyKey(), v),
        kind: 'CUSTOM',
        len: v.length,
        head: v.slice(0, Math.min(4, Math.floor(v.length / 4))),
      };
    } else if (typeof o.tag === 'string' && /^[a-z2-7]{8}$/.test(o.tag)) {
      entry = {
        tag: o.tag,
        kind: typeof o.kind === 'string' ? o.kind.slice(0, 32) : 'CUSTOM',
        len: typeof o.len === 'number' && o.len >= 0 ? Math.trunc(o.len) : 0,
        head: typeof o.head === 'string' ? o.head.slice(0, 4) : '',
      };
    } else throw new Error(tr('electron.common.privacy-allow-entry-invalid'));
    const data = this.store.snapshot();
    const list = data.privacyAllow ?? [];
    if (!list.some((a) => a.tag === entry.tag)) {
      if (list.length >= 200) throw new Error(tr('electron.common.privacy-too-many-allow-entries'));
      data.privacyAllow = [...list, { ...entry, at: Date.now() }];
      this.store.replace(data);
      this.commit();
    }
    return this.state();
  }

  removePrivacyAllow(tag: unknown): GatewayStateView {
    const data = this.store.snapshot();
    const list = data.privacyAllow ?? [];
    const next = list.filter((a) => a.tag !== tag);
    if (next.length !== list.length) {
      if (next.length) data.privacyAllow = next;
      else delete data.privacyAllow;
      this.store.replace(data);
      this.commit();
    }
    return this.state();
  }

  clearLearned(providerId: string): void {
    this.bumpLearn(providerId);
    this.store.setLearned(providerId, {});
    this.commit();
  }

  /**
   * 网关报回来的运行时学习（§7.4）：modelWire / droppedParams 直接记下；
   * 疑似不可用的协议先用这个供应商保存的 Key 跑一次单协议探测，确实不通才写 wireDown（TTL 见网关）。
   */
  async learn(e: LearnEvent): Promise<void> {
    const p = this.store.providers().find((x) => x.id === e.providerId);
    if (!p) return;
    const cur: LearnedState = structuredClone(this.store.snapshot().learned[p.id] ?? {});
    if (e.type === 'dropped-param') {
      const list = cur.droppedParams?.[e.wire] ?? [];
      if (list.includes(e.param)) return;
      cur.droppedParams = { ...cur.droppedParams, [e.wire]: [...list, e.param] };
    } else if (e.type === 'model-wire') {
      const all = (Object.keys(p.urls) as Wire[]).filter((w) => p.urls[w]);
      const allowed = (cur.modelWire?.[e.model] ?? all).filter((w) => w !== e.exclude);
      // 一个都不剩：说明判断不可靠，不学（宁可让请求照常失败）
      if (!allowed.length) return;
      cur.modelWire = { ...cur.modelWire, [e.model]: allowed };
    } else if (e.type === 'model-efforts') {
      // 思考档位被拒（§6.9.8）：记下这个模型实际接受的档位，带时间与目录版本（网关按它们判断过期）
      const efforts = e.efforts.filter((x): x is Effort => (EFFORTS as string[]).includes(x));
      if (!efforts.length || !e.model) return;
      const prevModel = cur.models?.[e.model];
      if (
        prevModel?.catalogVersion === e.catalogVersion &&
        JSON.stringify(prevModel.efforts) === JSON.stringify(efforts)
      )
        return;
      cur.models = {
        ...cur.models,
        [e.model]: {
          ...prevModel,
          at: Number.isFinite(e.at) ? e.at : Date.now(),
          catalogVersion: e.catalogVersion,
          efforts,
        },
      };
    } else if (e.type === 'custom-tools-refused') {
      // 这个模型的 Responses 接口不接受 custom 工具：之后一开始就用转换模式（§11.3）
      if (cur.customToolsRefused?.includes(e.model)) return;
      cur.customToolsRefused = [...(cur.customToolsRefused ?? []), e.model];
    } else if (e.type !== 'wire-suspect') {
      // 新版网关可能报来本版本不认识的学习类型：忽略，不当成「协议疑似不可用」处理
      this.d.logger.info('gateway learn event ignored', { type: (e as { type?: unknown }).type });
      return;
    } else {
      const url = p.urls[e.wire];
      if (!url) return;
      const keys = p.keys
        .filter((k) => k.enabled)
        .flatMap((k) => {
          const value = this.store.decrypt(k.enc, k.encryption);
          return value !== null ? [{ id: k.id, value }] : [];
        });
      const s = this.proc.getStatus();
      const gen = this.learnGen.get(p.id) ?? 0;
      const r = await (this.d.detectImpl ?? detect)({
        bases: { [e.wire]: url },
        keys,
        fallbackModel: p.models.find((m) => m.enabled)?.id,
        allowedPrivateHosts: this.store.snapshot().allowedPrivateHosts,
        ...(s.state === 'running' ? { selfPort: s.port } : {}),
      }).catch(() => null);
      if (!r || r.wires[e.wire]?.ok) return;
      // 探测期间清除了学习、改了 / 删了供应商：结论已过时，丢弃
      const now = this.store.providers().find((x) => x.id === p.id);
      if ((this.learnGen.get(p.id) ?? 0) !== gen || now?.urls[e.wire] !== url) return;
      // 基于最新状态只合并 wireDown：探测期间别的学习（dropped-param 等）不能被旧快照盖掉
      const latest: LearnedState = structuredClone(this.store.snapshot().learned[p.id] ?? {});
      latest.wireDown = { ...latest.wireDown, [e.wire]: { at: Date.now(), reason: e.reason } };
      this.d.logger.info('gateway learned', e);
      this.store.setLearned(p.id, latest);
      this.commit();
      return;
    }
    this.d.logger.info('gateway learned', e);
    this.store.setLearned(p.id, cur);
    this.commit();
  }

  /**
   * 网关报回来的 Key 状态（§11.1）：鉴权失败 / 限流时把原因记在这个 Key 上（「模型」页标红），
   * 恢复后清掉。只落盘和通知界面，不推新配置给网关。
   */
  keyStatus(e: KeyStatusEvent): void {
    const p = this.store.providers().find((x) => x.id === e.providerId);
    const k = p?.keys.find((x) => x.id === e.keyId);
    if (!p || !k) return;
    const label = WIRE_LABEL[e.wire] ?? e.wire;
    const next =
      e.status === 'ok'
        ? undefined
        : e.status === 'auth'
          ? tr('electron.common.authentication-failed', label, e.error ?? '')
          : tr('electron.common.rate-limited', label, e.error ?? '');
    if (k.lastError === next) return;
    this.store.upsertProvider({
      ...p,
      keys: p.keys.map((x) => (x.id === k.id ? { ...x, lastError: next } : x)),
    });
    this.store.save();
    this.changed();
  }

  confirmPrivateHost(hostPort: string): void {
    const hp = hostPort.trim().toLowerCase();
    if (!/^[a-z0-9.:[\]-]+:\d{1,5}$/.test(hp))
      throw new Error(tr('electron.common.the-address-must-be-host-port'));
    const data = this.store.snapshot();
    if (!data.allowedPrivateHosts.includes(hp)) data.allowedPrivateHosts.push(hp);
    this.store.replace(data);
    this.commit();
  }

  /**
   * 探测（§8）：可以传新填的地址和 Key，也可以只传已保存的供应商 id（用保存的地址和 Key）。
   * 在主进程里跑：只访问用户配置的地址，经同样的上游地址校验。
   */
  async detect(input: {
    providerId?: string;
    url?: string;
    urls?: Partial<Record<Wire, string>>;
    keys?: string[];
    savedKeyIds?: string[];
    fallbackModel?: string;
  }): Promise<DetectResult> {
    const saved = input.providerId
      ? this.store.providers().find((p) => p.id === input.providerId)
      : undefined;
    const bases = {
      ...(input.url ? normalizeBases(input.url) : {}),
      ...(saved?.urls ?? {}),
      ...(input.urls ?? {}),
    };
    const keys = [
      ...(saved?.keys ?? []).flatMap((k) => {
        if (input.savedKeyIds ? !input.savedKeyIds.includes(k.id) : !k.enabled) return [];
        const value = this.store.decrypt(k.enc, k.encryption);
        return value ? [{ id: k.id, value }] : [];
      }),
      ...(input.keys ?? []).flatMap((value, i) =>
        value.trim() ? [{ id: `new-${i}`, value: value.trim() }] : [],
      ),
    ];
    const s = this.proc.getStatus();
    return (this.d.detectImpl ?? detect)({
      bases,
      keys,
      fallbackModel: input.fallbackModel,
      allowedPrivateHosts: this.store.snapshot().allowedPrivateHosts,
      ...(s.state === 'running' ? { selfPort: s.port } : {}),
    });
  }

  /* ------------------------------ 界面入口（旧 IPC 与应用契约共用） ------------------------------ */

  /** 界面改某个客户端的模型分配：只接受 nomi 与内置 CLI，未知客户端报错 */
  setAssignmentFor(client: unknown, patch: Parameters<GatewayService['setAssignment']>[1]): void {
    this.setAssignment(knownClient(client), patch ?? {});
  }

  /** 界面重置某个客户端的令牌：只接受 nomi 与内置 CLI */
  resetTokenFor(client: unknown): void {
    this.resetToken(knownClient(client));
  }

  /** 网关进程熔断 / 启动失败后手动重试 */
  retry(): void {
    this.proc.retry();
  }

  /** 清空「最近隐藏的密钥」 */
  clearPrivacyLog(): Promise<void> {
    return this.privacyLog.clear();
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'GatewayService' });
    handle('ai:gateway:state', () => this.state());
    handle('ai:gateway:upsert-provider', (input) => this.upsertProvider(input as ProviderInput));
    handle('ai:gateway:remove-provider', (id) => this.removeProvider(String(id)));
    handle('ai:gateway:detect', (input) =>
      this.detect((input ?? {}) as Parameters<GatewayService['detect']>[0]),
    );
    handle('ai:gateway:set-assignment', (client, patch) =>
      this.setAssignmentFor(client, patch as Parameters<GatewayService['setAssignment']>[1]),
    );
    handle('ai:gateway:reset-token', (client) => this.resetTokenFor(client));
    handle('ai:gateway:clear-learned', (id) => this.clearLearned(String(id)));
    handle('ai:gateway:confirm-private-host', (hp) => this.confirmPrivateHost(String(hp)));
    handle('ai:gateway:retry', () => this.retry());
    handle('ai:gateway:set-options', (patch) =>
      this.setOptions((patch ?? {}) as GatewayOptionsPatch),
    );
    handle('ai:gateway:privacy-set-action', (kind, action) => this.setPrivacyAction(kind, action));
    handle('ai:gateway:privacy-add-secret', (input) => this.addPrivacySecret(input));
    handle('ai:gateway:privacy-remove-secret', (id) => this.removePrivacySecret(id));
    handle('ai:gateway:privacy-add-allow', (input) => this.addPrivacyAllow(input));
    handle('ai:gateway:privacy-remove-allow', (tag) => this.removePrivacyAllow(tag));
    handle('ai:gateway:privacy-log', () => this.privacyLogEntries());
    handle('ai:gateway:privacy-clear-log', () => this.clearPrivacyLog());
    handle('ai:gateway:privacy-preview', (text) => this.previewPrivacy(text));
  }

  dispose(): void {
    this.privacyLog.flush();
    this.proc.stop();
  }
}

let inst: GatewayService | null = null;
export function initGatewayService(d: GatewayServiceDeps): GatewayService {
  inst = new GatewayService(d);
  return inst;
}
export function getGatewayService(): GatewayService | null {
  return inst;
}

/** 插件清单声明的占位模型名（gateway 方式换模型）；没有就是 undefined */
function placeholderModelOf(kind: string): string | undefined {
  if (!isBuiltinCliId(kind)) return undefined;
  const v = BUILTIN_MANIFESTS[kind].clientSpec.placeholderModel;
  return typeof v === 'string' && v ? v : undefined;
}

function withEffective(
  m: GatewayModel,
  r: ResolvedModelMeta,
  priceOf?: (model: string) => LongContextPrice | undefined,
): ModelView {
  const price = r.longContext ? priceOf?.(m.id) : undefined;
  return {
    ...m,
    effective: {
      ctx: r.ctx,
      maxOutput: r.maxOutput,
      ...(r.reasoning !== undefined ? { reasoning: r.reasoning } : {}),
      ...(r.vision !== undefined ? { vision: r.vision } : {}),
      source: r.source,
      maxOutputSource: r.maxOutputSource,
      ...(r.longContext
        ? {
            longContext: {
              standard: r.longContext.standard,
              full: r.longContext.full,
              on: r.longContext.on,
              ...(price ? { price } : {}),
            },
          }
        : {}),
    },
  };
}
