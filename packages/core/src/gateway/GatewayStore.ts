/**
 * 网关存储（docs/design/unified-gateway.md §6.1）：userData/gateway/store.json，0600 原子写。
 * - Key 与客户端令牌用 SecretCipher 加密（safeStorage 不可用时按现有降级策略存 base64，并记下方式）；
 * - runtimeConfig() 生成推给网关进程的快照：Key 与令牌解密后只在内存里；
 * - 读不出的文件改名为 .corrupt-<时间戳> 后用空存储，不覆盖用户数据。
 */
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { SecretCipher } from '@nomi-ai/ai-runtime';
import {
  CLIENT_IDS,
  clampMaxRequestBodyBytes,
  type ClientId,
  type ClientModels,
  type GatewayConfig,
  type LearnedState,
  type ProviderQuirks,
  type RuntimeProvider,
} from '@nomi-ai/gateway';

import { writePrivateFileAtomic } from '../utils/privateFile';

import {
  presetEntry,
  resolveModelMeta,
  type MetaSource,
  type PresetModelMeta,
  type ResolvedModelMeta,
} from './modelMeta';
import type {
  ClientConfig,
  GatewayKey,
  GatewayModel,
  GatewayProvider,
  GatewayStoreData,
  KeyEncryption,
} from './types';

export const DEFAULT_GATEWAY_PORT = 18721;

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

function empty(): GatewayStoreData {
  return {
    version: 1,
    providers: [],
    clients: {},
    learned: {},
    allowedPrivateHosts: [],
    port: DEFAULT_GATEWAY_PORT,
  };
}

/** 列表里显示的 Key 掩码：sk-…wxyz（短 Key 只露最后 2 位） */
export function maskKey(key: string): string {
  if (key.length <= 8) return `${'•'.repeat(Math.max(2, key.length - 2))}${key.slice(-2)}`;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** 客户端令牌：nomi-gw-<client>-<32 字节 base64url>（§10.2） */
export function newClientToken(client: ClientId): string {
  return `nomi-gw-${client}-${randomBytes(32).toString('base64url')}`;
}

/** URL 安全的短名（用在模型名前缀里） */
export function providerSlug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return s || 'provider';
}

export class GatewayStore {
  private data: GatewayStoreData;

  constructor(
    private readonly d: {
      file: string;
      cipher: SecretCipher;
      logger?: Logger;
      /** 按预设 id 取厂商差异（ai-runtime 的 presets，由调用方注入，避免这里加载 AI SDK） */
      presetQuirks?: (presetId: string | undefined) => ProviderQuirks | undefined;
      /** 按预设 id 取预设整理的模型元数据（§12.7.2 第 2 级），同样由调用方注入 */
      presetModels?: (presetId: string | undefined) => readonly PresetModelMeta[] | undefined;
    },
  ) {
    this.data = this.load();
  }

  get file(): string {
    return this.d.file;
  }

  exists(): boolean {
    return fs.existsSync(this.d.file);
  }

  private load(): GatewayStoreData {
    let raw: string;
    try {
      raw = fs.readFileSync(this.d.file, 'utf8');
    } catch {
      return empty();
    }
    try {
      const j = JSON.parse(raw) as Partial<GatewayStoreData>;
      if (j.version !== 1) throw new Error(`unsupported version ${String(j.version)}`);
      return { ...empty(), ...j } as GatewayStoreData;
    } catch (e) {
      const bad = `${this.d.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.d.file, bad);
      } catch {
        /* 改名失败也不覆盖：下次保存才会写 */
      }
      this.d.logger?.warn('gateway store unreadable, moved aside', { bad, error: String(e) });
      return empty();
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
    writePrivateFileAtomic(this.d.file, JSON.stringify(this.data, null, 2));
  }

  snapshot(): GatewayStoreData {
    return structuredClone(this.data);
  }

  /** 整体替换（迁移用）；调用方负责 save() */
  replace(data: GatewayStoreData): void {
    this.data = data;
  }

  /* ------------------------------ 加解密 ------------------------------ */

  encrypt(plain: string): { enc: string; encryption: KeyEncryption } {
    return { enc: this.d.cipher.encrypt(plain), encryption: this.d.cipher.kind };
  }

  decrypt(enc: string, encryption: KeyEncryption): string | null {
    try {
      if (encryption === this.d.cipher.kind) return this.d.cipher.decrypt(enc);
      if (encryption === 'none') return Buffer.from(enc, 'base64').toString('utf8');
      return null; // safeStorage 密文但当前不可用（换了机器 / 钥匙串）
    } catch {
      return null;
    }
  }

  makeKey(plain: string, o: { name?: string; wire?: GatewayKey['wire'] } = {}): GatewayKey {
    return {
      id: `k-${randomUUID().slice(0, 8)}`,
      ...(o.name ? { name: o.name } : {}),
      ...this.encrypt(plain),
      masked: maskKey(plain),
      ...(o.wire ? { wire: o.wire } : {}),
      enabled: true,
    };
  }

  /* ------------------------------ 客户端 ------------------------------ */

  /** 确保每个客户端都有令牌（首次使用时生成） */
  ensureClients(): boolean {
    let changed = false;
    for (const id of CLIENT_IDS) {
      const c = this.data.clients[id];
      if (c?.tokenEnc && this.decrypt(c.tokenEnc, c.tokenEncryption)) continue;
      const t = this.encrypt(newClientToken(id));
      this.data.clients[id] = {
        ...(c ?? { models: {} }),
        tokenEnc: t.enc,
        tokenEncryption: t.encryption,
      };
      changed = true;
    }
    return changed;
  }

  /* ------------------------------ 隐私模式 ------------------------------ */

  /** 确保有占位符的 HMAC 密钥（首次使用、或换了机器解不开时重新生成） */
  ensurePrivacyKey(): boolean {
    const d = this.data;
    if (
      d.privacyKeyEnc &&
      d.privacyKeyEncryption &&
      this.decrypt(d.privacyKeyEnc, d.privacyKeyEncryption)
    )
      return false;
    const k = this.encrypt(randomBytes(32).toString('hex'));
    d.privacyKeyEnc = k.enc;
    d.privacyKeyEncryption = k.encryption;
    return true;
  }

  /** 解不开时用这次进程的临时密钥：隐私模式照常工作，只是重启后占位符会变（缓存失效一次） */
  privacyKey(): string {
    const d = this.data;
    const key =
      d.privacyKeyEnc && d.privacyKeyEncryption
        ? this.decrypt(d.privacyKeyEnc, d.privacyKeyEncryption)
        : null;
    return key ?? (this.ephemeralPrivacyKey ??= randomBytes(32).toString('hex'));
  }

  private ephemeralPrivacyKey: string | null = null;

  clientToken(id: ClientId): string | null {
    const c = this.data.clients[id];
    return c ? this.decrypt(c.tokenEnc, c.tokenEncryption) : null;
  }

  resetToken(id: ClientId): void {
    const t = this.encrypt(newClientToken(id));
    const c = this.data.clients[id];
    this.data.clients[id] = {
      ...(c ?? { models: {} }),
      tokenEnc: t.enc,
      tokenEncryption: t.encryption,
    };
  }

  setClient(
    id: ClientId,
    patch: {
      models?: ClientModels;
      newTabSource?: ClientConfig['newTabSource'];
      newTabAccountId?: string | null;
    },
  ): void {
    const c = this.data.clients[id];
    if (!c) throw new Error(`unknown client ${id}`);
    this.data.clients[id] = {
      ...c,
      // null / 空串表示清除（如「跟随对话」）
      ...(patch.models
        ? {
            models: Object.fromEntries(
              Object.entries({ ...c.models, ...patch.models }).filter(
                ([, v]) => v !== null && v !== undefined && v !== '',
              ),
            ) as ClientModels,
          }
        : {}),
      ...(patch.newTabSource ? { newTabSource: patch.newTabSource } : {}),
      // undefined = 不变；null = 清除（跟随默认账号）；字符串 = 指定账号（含 local-<cli>）
      ...(patch.newTabAccountId !== undefined
        ? patch.newTabAccountId
          ? { newTabAccountId: patch.newTabAccountId }
          : { newTabAccountId: undefined }
        : {}),
    };
  }

  /* ------------------------------ 供应商 ------------------------------ */

  providers(): GatewayProvider[] {
    return this.data.providers;
  }

  uniqueProviderId(base: string): string {
    const taken = new Set(this.data.providers.flatMap((p) => [p.id, ...(p.aliases ?? [])]));
    let id = providerSlug(base);
    for (let n = 2; taken.has(id); n++) id = `${providerSlug(base)}-${n}`;
    return id;
  }

  upsertProvider(p: GatewayProvider): void {
    const i = this.data.providers.findIndex((x) => x.id === p.id);
    const next = { ...p, updatedAt: Date.now() };
    if (i >= 0) this.data.providers[i] = next;
    else this.data.providers.push(next);
  }

  removeProvider(id: string): void {
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    delete this.data.learned[id];
  }

  setLearned(providerId: string, learned: LearnedState): void {
    this.data.learned[providerId] = learned;
  }

  /** 供应商里一个模型的生效元数据（§12.7.2）；presetId 给环境变量供应商用（它们不在 store 里） */
  modelMeta(
    p: Pick<GatewayProvider, 'presetId' | 'models'>,
    modelId: string,
    opts: { longContext?: boolean } = {},
  ): ResolvedModelMeta {
    return resolveModelMeta(
      p.models.find((m) => m.id === modelId),
      modelId,
      presetEntry(this.d.presetModels?.(p.presetId), modelId),
      opts,
    );
  }

  /**
   * 推给网关的模型条目：把用户 / 预设 / 模型列表给的上限写进去，网关按它压输出上限（§12.7.3）。
   * 只来自内置目录的不写：网关自己也读目录，写进去会被当成用户设置、盖过供应商规格
   */
  private runtimeModels(p: GatewayProvider): GatewayModel[] {
    const fromConfig = (src: MetaSource) => src !== 'catalog' && src !== 'default';
    return p.models.map((m) => {
      const r = this.modelMeta(p, m.id);
      // 网关不按窗口拦请求：写模型的完整窗口，不受标准窗口 / 标签长上下文选择影响
      const ctx = r.longContext
        ? { v: r.longContext.full, src: r.longContext.fullSource }
        : { v: r.ctx, src: r.source };
      return {
        ...m,
        ...(fromConfig(ctx.src) ? { ctx: ctx.v } : {}),
        ...(fromConfig(r.maxOutputSource) ? { maxOutput: r.maxOutput } : {}),
      };
    });
  }

  private quirksOf(p: GatewayProvider): ProviderQuirks | undefined {
    const preset = this.d.presetQuirks?.(p.presetId);
    if (!preset && !p.quirks) return undefined;
    return { ...preset, ...p.quirks };
  }

  /* ------------------------------ 运行时快照 ------------------------------ */

  runtimeConfig(
    extra: { legacyToken?: string; envProviders?: RuntimeProvider[] } = {},
  ): GatewayConfig {
    const providers: RuntimeProvider[] = this.data.providers.map((p) => ({
      id: p.id,
      ...(p.aliases ? { aliases: p.aliases } : {}),
      name: p.name,
      enabled: p.enabled,
      urls: p.urls,
      // 按创建时的预设匹配网关的供应商规格（§6.3）
      ...(p.presetId ? { preset: p.presetId } : {}),
      // 一个 Key 都没存的（本地服务）给一个空 Key，否则路由找不到候选
      keys: !p.keys.length
        ? [{ id: 'none', value: '', enabled: true }]
        : p.keys.flatMap((k) => {
            const value = this.decrypt(k.enc, k.encryption);
            return value === null
              ? []
              : [
                  {
                    id: k.id,
                    ...(k.name ? { name: k.name } : {}),
                    value,
                    ...(k.wire ? { wire: k.wire } : {}),
                    enabled: k.enabled,
                    ...(k.maxConcurrency ? { maxConcurrency: k.maxConcurrency } : {}),
                    ...(k.rpm ? { rpm: k.rpm } : {}),
                  },
                ];
          }),
      models: this.runtimeModels(p),
      ...(p.fallback ? { fallback: p.fallback } : {}),
      ...(p.headers ? { headers: p.headers } : {}),
      ...(p.userAgent ? { userAgent: p.userAgent } : {}),
      ...(p.modelMap ? { modelMap: p.modelMap } : {}),
      ...(p.detected
        ? {
            detected: Object.fromEntries(
              Object.entries(p.detected).map(([w, r]) => [
                w,
                { ok: r.ok, ...(r.auth ? { auth: r.auth } : {}) },
              ]),
            ),
          }
        : {}),
      // 预设里的厂商差异随版本更新（如后来补上的 MiniMax reasoning_split），已保存的供应商也能用上；
      // 保存时带的值优先
      ...(this.quirksOf(p) ? { quirks: this.quirksOf(p) } : {}),
    }));
    const clients: GatewayConfig['clients'] = {};
    for (const id of CLIENT_IDS) {
      const c = this.data.clients[id];
      const token = c ? this.decrypt(c.tokenEnc, c.tokenEncryption) : null;
      if (c && token) clients[id] = { token, models: c.models };
    }
    return {
      host: '127.0.0.1',
      port: this.data.port,
      providers: [...providers, ...(extra.envProviders ?? [])],
      clients,
      ...(extra.legacyToken ? { legacyToken: extra.legacyToken } : {}),
      allowedPrivateHosts: this.data.allowedPrivateHosts,
      learned: this.data.learned,
      ...(this.data.strictParams ? { strictParams: true } : {}),
      ...(typeof this.data.maxRequestBodyBytes === 'number'
        ? { maxRequestBodyBytes: clampMaxRequestBodyBytes(this.data.maxRequestBodyBytes) }
        : {}),
      // 隐私模式默认开：没有 privacyMode 字段也是开（docs/design/secret-privacy.md §11）
      privacy: this.runtimePrivacy(),
    };
  }

  /** 快照里的隐私模式：自定义密钥解密后只在内存里，例外名单只有标记 */
  private runtimePrivacy(): NonNullable<GatewayConfig['privacy']> {
    const d = this.data;
    const known = (d.privacySecrets ?? []).flatMap((s) => {
      const value = this.decrypt(s.enc, s.encryption);
      return value ? [{ kind: 'CUSTOM', value }] : [];
    });
    return {
      enabled: d.privacyMode !== false,
      ...(d.privacyStrict ? { strict: true } : {}),
      ...(d.privacyLocal ? { local: true } : {}),
      ...(d.privacyShape ? { shape: true } : {}),
      key: this.privacyKey(),
      ...(d.privacyActions && Object.keys(d.privacyActions).length
        ? { actions: { ...d.privacyActions } }
        : {}),
      ...(known.length ? { known } : {}),
      ...(d.privacyAllow?.length ? { allow: d.privacyAllow.map((a) => a.tag) } : {}),
    };
  }
}
