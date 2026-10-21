/**
 * 一次性迁移（docs/design/unified-gateway.md §6.3）：把 Nomi 的 ai-providers.json 和
 * cli-providers/<kind>/store.json 合并进网关存储。
 * - 按「规范化后的主机名 + Key 明文」去重：同一个 Key 在不同地方配了不同协议，合并成一个供应商的多个地址；
 * - Nomi 当前供应商 + 默认模型、任务路由 → clients.nomi；各 CLI 当前启用的第三方 → clients[kind]；
 * - 旧路由改过的端口沿用；
 * - 旧文件只读不改：旧界面与旧路由在 M3 之前仍在使用它们（改名为 .migrated 留到移除旧代码时）。
 * 官方账号保险箱（cli-accounts）不读不写。
 */
import fs from 'fs';
import path from 'path';

import type { ProviderStoreData, SecretCipher } from '@nomi-ai/ai-runtime';
import type { ClientId, Wire } from '@nomi-ai/gateway';

import { DEFAULT_GATEWAY_PORT, type GatewayStore } from './GatewayStore';
import type { GatewayModel, GatewayProvider } from './types';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

const CLI_KINDS = ['claude', 'codex', 'dsh', 'grok', 'gemini'] as const;

const NOMI_PROTOCOL_WIRE: Record<string, Wire> = {
  'openai-chat': 'chat',
  'openai-responses': 'responses',
  anthropic: 'messages',
};

const CLI_FORMAT_WIRE: Record<string, Wire> = {
  anthropic_messages: 'messages',
  openai_chat_completions: 'chat',
  openai_responses: 'responses',
  gemini_generate_content: 'gemini',
};

/** 完整接口地址末尾的接口路径（/v1 留给各协议按约定处理） */
const SUFFIX = /\/(?:chat\/completions|responses|messages)$/i;

/** 旧地址 → 这个协议的 base（与网关拼地址的约定一致） */
export function legacyBase(wire: Wire, raw: string, fullUrl = false): string {
  let s = raw.trim().replace(/\/+$/, '');
  if (fullUrl) s = s.replace(SUFFIX, '').replace(/\/+$/, '');
  if (wire === 'messages') return s.replace(/\/v1$/, '');
  if (wire === 'gemini') return /\/v1(beta|alpha)?\d*$/.test(s) ? s : `${s}/v1beta`;
  return s;
}

interface Entry {
  name: string;
  presetId?: string;
  wire: Wire;
  base: string;
  keys: string[];
  /** 启用的模型 */
  models: string[];
  /** 拉到但没启用的模型 */
  listed: string[];
  modelMap?: Array<{ from: string; to: string }>;
  headers?: Record<string, string>;
  userAgent?: string;
  enabled: boolean;
  origin:
    { kind: 'nomi'; id: string } | { kind: 'cli'; cli: (typeof CLI_KINDS)[number]; id: string };
}

function hostOf(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface LegacySources {
  nomiFile: string;
  cliRoot: string;
  /** 解 ai-providers.json 里 encryption='safeStorage' 的 Key */
  nomiCipher: SecretCipher;
  /** 解 CLI 存储的 keyEnc（先试 safeStorage，再按明文 base64；旧格式没有标记） */
  cliDecrypt: (enc: string) => string;
  /** 把任意版本的 ai-providers.json 规范成 v2（ai-runtime 的 migrateStoreData） */
  normalizeNomi: (raw: Record<string, unknown>) => ProviderStoreData;
}

export interface MigrationResult {
  migrated: boolean;
  providers: number;
  files: string[];
  /** 读不出明文的 Key（比如换了机器，钥匙串不同） */
  undecryptable: number;
}

function nomiEntries(data: ProviderStoreData, cipher: SecretCipher, bad: { n: number }): Entry[] {
  return data.providers.map((p) => {
    const wire = NOMI_PROTOCOL_WIRE[p.protocol] ?? 'chat';
    const keys = p.keys.flatMap((k) => {
      try {
        const v =
          k.encryption === cipher.kind
            ? cipher.decrypt(k.secret)
            : Buffer.from(k.secret, 'base64').toString('utf8');
        return v ? [v] : [];
      } catch {
        bad.n++;
        return [];
      }
    });
    const models = [...new Set([p.defaultModel, ...p.models].filter(Boolean))];
    return {
      name: p.name,
      presetId: p.presetId,
      wire,
      base: legacyBase(wire, p.baseURL, p.fullUrl),
      keys,
      models,
      listed: (p.fetchedModels ?? []).map((m) => m.id).filter((id) => !models.includes(id)),
      ...(p.modelMap?.length ? { modelMap: p.modelMap } : {}),
      ...(p.headers && Object.keys(p.headers).length ? { headers: p.headers } : {}),
      ...(p.userAgent ? { userAgent: p.userAgent } : {}),
      enabled: p.enabled,
      origin: { kind: 'nomi', id: p.id },
    };
  });
}

interface CliProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiFormat: string;
  keyEnc: string;
  active: boolean;
  presetId?: string;
}

function cliEntries(
  cliRoot: string,
  decrypt: (enc: string) => string,
  files: string[],
): {
  entries: Entry[];
  active: Partial<Record<(typeof CLI_KINDS)[number], { id: string; model: string }>>;
} {
  const entries: Entry[] = [];
  const active: Partial<Record<(typeof CLI_KINDS)[number], { id: string; model: string }>> = {};
  for (const cli of CLI_KINDS) {
    const file = path.join(cliRoot, cli, 'store.json');
    const j = readJson(file);
    if (!j) continue;
    files.push(file);
    for (const p of (Array.isArray(j.profiles) ? j.profiles : []) as CliProfile[]) {
      if (!p?.id || !p.baseUrl) continue;
      const wire = cli === 'gemini' ? 'gemini' : (CLI_FORMAT_WIRE[p.apiFormat] ?? 'chat');
      const key = p.keyEnc ? decrypt(p.keyEnc) : '';
      entries.push({
        name: p.name || hostOf(p.baseUrl),
        ...(p.presetId && p.presetId !== 'custom' ? { presetId: p.presetId } : {}),
        wire,
        base: legacyBase(wire, p.baseUrl),
        keys: key ? [key] : [],
        models: p.model ? [p.model] : [],
        listed: [],
        enabled: true,
        origin: { kind: 'cli', cli, id: p.id },
      });
      if (p.active && p.model) active[cli] = { id: p.id, model: p.model };
    }
  }
  return { entries, active };
}

/** 同主机且共享任一 Key（都没有 Key 时只看主机）→ 同一个供应商 */
function sameProvider(a: Entry, b: { host: string; keys: string[] }): boolean {
  if (hostOf(a.base) !== b.host) return false;
  if (!a.keys.length && !b.keys.length) return true;
  return a.keys.some((k) => b.keys.includes(k));
}

export function migrateLegacy(
  store: GatewayStore,
  src: LegacySources,
  logger?: Logger,
): MigrationResult {
  const files: string[] = [];
  const bad = { n: 0 };
  const now = Date.now();
  const nomiRaw = readJson(src.nomiFile);
  const nomi = nomiRaw ? src.normalizeNomi(nomiRaw) : null;
  if (nomiRaw) files.push(src.nomiFile);
  const fromNomi = nomi ? nomiEntries(nomi, src.nomiCipher, bad) : [];
  const fromCli = cliEntries(src.cliRoot, src.cliDecrypt, files);
  const all = [...fromNomi, ...fromCli.entries];

  const groups: Array<{ host: string; keys: string[]; entries: Entry[] }> = [];
  for (const e of all) {
    const g = groups.find((x) => sameProvider(e, x));
    if (g) {
      g.entries.push(e);
      for (const k of e.keys) if (!g.keys.includes(k)) g.keys.push(k);
    } else groups.push({ host: hostOf(e.base), keys: [...e.keys], entries: [e] });
  }

  /** 旧来源 id → 新供应商 id */
  const idOf = new Map<string, string>();
  for (const g of groups) {
    const first = g.entries.find((e) => e.origin.kind === 'nomi') ?? g.entries[0]!;
    const id = store.uniqueProviderId(first.presetId ?? first.name);
    const urls: Partial<Record<Wire, string>> = {};
    for (const e of g.entries) urls[e.wire] ??= e.base;
    const models: GatewayModel[] = [];
    const add = (mid: string, enabled: boolean) => {
      const hit = models.find((m) => m.id === mid);
      if (hit) hit.enabled ||= enabled;
      else models.push({ id: mid, enabled, metaSource: enabled ? 'user' : 'listed' });
    };
    for (const e of g.entries) {
      e.models.forEach((m) => add(m, true));
      e.listed.forEach((m) => add(m, false));
    }
    const provider: GatewayProvider = {
      id,
      name: first.name,
      ...(first.presetId ? { presetId: first.presetId } : {}),
      enabled: g.entries.some((e) => e.enabled),
      urls,
      keys: g.keys.map((k, i) => store.makeKey(k, { name: i === 0 ? '主 Key' : `备用 Key ${i}` })),
      models,
      modelsSource: 'manual',
      ...(g.entries.find((e) => e.modelMap)?.modelMap
        ? { modelMap: g.entries.find((e) => e.modelMap)!.modelMap }
        : {}),
      ...(g.entries.find((e) => e.headers)?.headers
        ? { headers: g.entries.find((e) => e.headers)!.headers }
        : {}),
      ...(g.entries.find((e) => e.userAgent)?.userAgent
        ? { userAgent: g.entries.find((e) => e.userAgent)!.userAgent }
        : {}),
      source: 'user',
      createdAt: now,
      updatedAt: now,
    };
    store.upsertProvider(provider);
    for (const e of g.entries) idOf.set(`${e.origin.kind}:${e.origin.id}`, id);
  }

  store.ensureClients();
  // Nomi：当前供应商 + 默认模型 → main；任务路由 → tools / summary
  if (nomi) {
    const ref = (providerId: string | undefined, model?: string) => {
      if (!providerId) return undefined;
      const p = nomi.providers.find((x) => x.id === providerId);
      const id = idOf.get(`nomi:${providerId}`);
      const m = model || p?.defaultModel;
      return id && m ? `${id}/${m}` : undefined;
    };
    const main = ref(nomi.activeProviderId);
    const tools = ref(nomi.routes['agent-tools']?.providerId, nomi.routes['agent-tools']?.model);
    const summary = ref(nomi.routes.summary?.providerId, nomi.routes.summary?.model);
    store.setClient('nomi', {
      models: {
        ...(main ? { main } : {}),
        ...(tools ? { tools } : {}),
        ...(summary ? { summary } : {}),
      },
    });
  }
  // 各 CLI 当前启用的第三方 → 这个 CLI 的第三方模型，新标签默认用第三方
  for (const cli of CLI_KINDS) {
    const a = fromCli.active[cli];
    const id = a ? idOf.get(`cli:${a.id}`) : undefined;
    if (a && id)
      store.setClient(cli as ClientId, {
        models: { main: `${id}/${a.model}` },
        newTabSource: 'thirdParty',
      });
  }

  const data = store.snapshot();
  const routing = readJson(path.join(src.cliRoot, 'routing.json'));
  const port = Number(routing?.port);
  if (Number.isInteger(port) && port > 0 && port < 65536 && port !== DEFAULT_GATEWAY_PORT)
    data.port = port;
  data.migratedFrom = { at: now, files };
  store.replace(data);
  store.save();
  logger?.info('gateway: migrated legacy providers', {
    providers: groups.length,
    files: files.length,
    undecryptable: bad.n,
  });
  return { migrated: true, providers: groups.length, files, undecryptable: bad.n };
}
