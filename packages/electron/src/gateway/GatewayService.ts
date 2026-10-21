/**
 * 网关服务（docs/design/unified-gateway.md §5、§6、§15）：主进程里的存储、迁移、网关进程守护与 IPC。
 * - 首次启动（还没有 store.json）时从旧存储迁移一次；每个客户端确保有令牌；
 * - 配置改动 → 重新生成快照推给网关进程（Key 解密只在主进程，经 parentPort 传过去，只在内存里）；
 * - 旧的本地路由服务开着且占用同一端口时，网关先用临时端口，等旧路由移除（M3）后接管；
 * - IPC 一律 ai:gateway:*；返回给渲染进程的数据里 Key 只给掩码，令牌不返回。
 */
import path from 'path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';
import {
  CLIENT_IDS,
  detect,
  isPrivateHost,
  normalizeBases,
  preferredWire,
  type ClientId,
  type ClientModels,
  type DetectResult,
  type GatewayConfig,
  type UsageEvent,
  type Wire,
} from '@nomi-ai/gateway';

import { t as tr } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';

import { GatewayProcess, type GatewayStatus } from './GatewayProcess';
import { GatewayStore } from './GatewayStore';
import { migrateLegacy } from './migrate';
import type { GatewayKey, GatewayModel, GatewayProvider, StoredProbe } from './types';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type NomiRole = 'chat' | 'agent-tools' | 'summary';

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
  newKeys?: Array<{ value: string; name?: string; wire?: Wire }>;
  /** 已有 Key 的顺序 / 启用 / 名称（不在列表里的已有 Key 视为删除） */
  keys?: Array<{ id: string; name?: string; enabled: boolean; wire?: Wire }>;
  models?: GatewayModel[];
  modelMap?: Array<{ from: string; to: string }>;
  headers?: Record<string, string>;
  userAgent?: string;
  fallback?: string[];
  detected?: Partial<Record<Wire, StoredProbe>>;
}

export interface ProviderView extends Omit<GatewayProvider, 'keys'> {
  keys: Array<Omit<GatewayKey, 'enc' | 'encryption'> & { decryptable: boolean }>;
}

export interface GatewayStateView {
  status: GatewayStatus;
  providers: ProviderView[];
  clients: Partial<
    Record<ClientId, { models: ClientModels; newTabSource?: 'official' | 'thirdParty' }>
  >;
  allowedPrivateHosts: string[];
  port: number;
  migratedFrom?: { at: number; files: string[] };
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
  broadcast?: (channel: string, payload: unknown) => void;
}

export class GatewayService {
  readonly store: GatewayStore;
  private readonly proc: GatewayProcess;

  constructor(private readonly d: GatewayServiceDeps) {
    this.store = new GatewayStore({
      file: path.join(d.root, 'store.json'),
      cipher: d.cipher,
      logger: d.logger,
    });
    this.proc =
      d.process ??
      new GatewayProcess({
        logger: d.logger,
        onUsage: (e) => d.onUsage?.(e),
        onStatus: () => this.changed(),
      });
  }

  /** 启动：迁移（只一次）→ 令牌 → 拉起网关 */
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
    if (this.store.ensureClients() || !this.store.exists()) this.store.save();
    this.push();
  }

  /** 推给网关进程的快照 */
  runtimeConfig(): GatewayConfig {
    const cfg = this.store.runtimeConfig({ legacyToken: this.d.legacy?.token() ?? undefined });
    // 旧路由占着端口时先用临时端口
    if (this.d.legacy?.routeListening()) cfg.port = 0;
    return cfg;
  }

  private push(): void {
    this.proc.apply(this.runtimeConfig());
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
    const key = p.keys
      .filter((k) => k.enabled)
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
    if (!models?.main) return null;
    const ref =
      (role === 'agent-tools' ? models.tools : role === 'summary' ? models.summary : undefined) ??
      models.main;
    const picked = preferredWire(this.store.runtimeConfig(), 'nomi', ref);
    if (!picked?.upstreams.length) return null;
    const receiver = picked.upstreams.find((u) => !privateUrl(u.url)) ?? picked.upstreams[0]!;
    return { ...picked, receiver };
  }

  /* ------------------------------ 渲染进程视图 ------------------------------ */

  state(): GatewayStateView {
    const data = this.store.snapshot();
    return {
      status: this.proc.getStatus(),
      providers: data.providers.map((p) => ({
        ...p,
        keys: p.keys.map(({ enc, encryption, ...k }) => ({
          ...k,
          decryptable: this.store.decrypt(enc, encryption) !== null,
        })),
      })),
      clients: Object.fromEntries(
        CLIENT_IDS.flatMap((id) => {
          const c = data.clients[id];
          return c
            ? [
                [
                  id,
                  { models: c.models, ...(c.newTabSource ? { newTabSource: c.newTabSource } : {}) },
                ],
              ]
            : [];
        }),
      ),
      allowedPrivateHosts: data.allowedPrivateHosts,
      port: data.port,
      ...(data.migratedFrom ? { migratedFrom: data.migratedFrom } : {}),
    };
  }

  /* ------------------------------ 修改 ------------------------------ */

  upsertProvider(input: ProviderInput): ProviderView {
    const name = input.name.trim();
    if (!name) throw new Error(tr('名称不能为空'));
    const now = Date.now();
    const prev = input.id ? this.store.providers().find((p) => p.id === input.id) : undefined;
    if (input.id && !prev) throw new Error(tr('供应商不存在'));
    if (prev?.source === 'env') throw new Error(tr('环境变量提供的供应商是只读的'));
    const existing = new Map((prev?.keys ?? []).map((k) => [k.id, k]));
    const kept: GatewayKey[] = input.keys
      ? input.keys.flatMap((k) => {
          const old = existing.get(k.id);
          return old
            ? [
                {
                  ...old,
                  enabled: k.enabled,
                  ...(k.name !== undefined ? { name: k.name } : {}),
                  wire: k.wire,
                },
              ]
            : [];
        })
      : (prev?.keys ?? []);
    const added = (input.newKeys ?? [])
      .map((k) => ({ ...k, value: k.value.trim() }))
      .filter((k) => k.value)
      // 名称留空时界面按顺序显示「主 Key / 备用 Key N」（随界面语言翻译）
      .map((k) => this.store.makeKey(k.value, { name: k.name, wire: k.wire }));
    const p: GatewayProvider = {
      ...(prev ?? { createdAt: now, source: 'user' as const, modelsSource: 'manual' as const }),
      id: prev?.id ?? this.store.uniqueProviderId(input.presetId ?? name),
      name,
      ...(input.presetId ? { presetId: input.presetId } : {}),
      enabled: input.enabled ?? prev?.enabled ?? true,
      urls: Object.fromEntries(
        Object.entries(input.urls).filter(([, u]) => u?.trim()),
      ) as GatewayProvider['urls'],
      keys: [...kept, ...added],
      models: input.models ?? prev?.models ?? [],
      ...(input.modelMap ? { modelMap: input.modelMap } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent || undefined } : {}),
      ...(input.fallback ? { fallback: input.fallback } : {}),
      ...(input.detected ? { detected: input.detected } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    } as GatewayProvider;
    this.store.upsertProvider(p);
    this.commit();
    return this.state().providers.find((x) => x.id === p.id)!;
  }

  removeProvider(id: string): void {
    const p = this.store.providers().find((x) => x.id === id);
    if (!p) return;
    if (p.source === 'env') throw new Error(tr('环境变量提供的供应商是只读的'));
    this.store.removeProvider(id);
    this.commit();
  }

  setAssignment(
    client: ClientId,
    patch: { models?: ClientModels; newTabSource?: 'official' | 'thirdParty' },
  ): void {
    this.store.setClient(client, patch);
    this.commit();
  }

  resetToken(client: ClientId): void {
    this.store.resetToken(client);
    this.commit();
  }

  clearLearned(providerId: string): void {
    this.store.setLearned(providerId, {});
    this.commit();
  }

  confirmPrivateHost(hostPort: string): void {
    const hp = hostPort.trim().toLowerCase();
    if (!/^[a-z0-9.:[\]-]+:\d{1,5}$/.test(hp)) throw new Error(tr('地址格式应为 host:port'));
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
    const keys = input.keys?.length
      ? input.keys.map((value, i) => ({ id: `new-${i}`, value }))
      : (saved?.keys ?? []).flatMap((k) => {
          const value = this.store.decrypt(k.enc, k.encryption);
          return value ? [{ id: k.id, value }] : [];
        });
    const s = this.proc.getStatus();
    return detect({
      bases,
      keys,
      fallbackModel: input.fallbackModel,
      allowedPrivateHosts: this.store.snapshot().allowedPrivateHosts,
      ...(s.state === 'running' ? { selfPort: s.port } : {}),
    });
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
    handle('ai:gateway:set-assignment', (client, patch) => {
      if (!CLIENT_IDS.includes(client as ClientId)) throw new Error(tr('未知客户端'));
      this.setAssignment(
        client as ClientId,
        (patch ?? {}) as Parameters<GatewayService['setAssignment']>[1],
      );
    });
    handle('ai:gateway:reset-token', (client) => {
      if (!CLIENT_IDS.includes(client as ClientId)) throw new Error(tr('未知客户端'));
      this.resetToken(client as ClientId);
    });
    handle('ai:gateway:clear-learned', (id) => this.clearLearned(String(id)));
    handle('ai:gateway:confirm-private-host', (hp) => this.confirmPrivateHost(String(hp)));
    handle('ai:gateway:retry', () => this.proc.retry());
  }

  dispose(): void {
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
