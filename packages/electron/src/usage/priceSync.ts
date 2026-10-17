/**
 * 手动价格同步：用户点「同步价格」才联网，从 models.dev 下载公开价格表（https://models.dev/api.json，MIT）。
 *
 * 隐私：只发一个 GET（带 Accept-Encoding / If-None-Match），不带 cookie、不带任何用量或账号信息；
 * 没有后台轮询、没有启动时检查。命中 ETag（304）就不重新下载。
 *
 * 数据：只取「一手提供商」（模型自己的厂商，不取 openrouter 之类的转售商），只提取
 * input / output / cache_read / cache_write 和按上下文长度分档的 tiers；
 * 校验丢弃负数 / 非数 / 缺 input、output 的条目；status = deprecated 的不覆盖内置；
 * 只做增补 / 覆盖，从不删除内置表里 models.dev 已下架的旧模型。
 * 结果作为覆盖层缓存在 userData（price-sync.json）；同步失败 / 没同步过就回退内置表。
 * 价格优先级：用户自定义 > 同步 > 内置（见 pricing.findPrice）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomic } from '../utils/privateFile';

import { BUILTIN_PRICES, normalizeModel, VERSION_SUFFIX } from './pricing';
import type { PriceEntry, PriceTier } from './types';

export const PRICE_SYNC_URL = 'https://models.dev/api.json';
/** 响应体上限（实测约 5.7 MB） */
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
/** 解析出的有效条目少于这个数，视为异常响应，不覆盖已有缓存 */
const MIN_ENTRIES = 10;

/**
 * 一手提供商（按优先级：同名模型先到先得）。阿里云（alibaba）同时转售 deepseek / kimi / glm，
 * 所以放在最后，并且只收它自己的千问系列。
 */
const FIRST_PARTY: Array<{ id: string; only?: RegExp }> = [
  { id: 'anthropic' },
  { id: 'openai' },
  { id: 'google' },
  { id: 'deepseek' },
  { id: 'moonshotai' },
  { id: 'zhipuai' },
  { id: 'minimax' },
  { id: 'xai' },
  { id: 'mistral' },
  { id: 'alibaba', only: /^(qwen|qwq|qvq)/i },
];

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** 合法价格：有限的非负数（0 合法，例如免费模型） */
const price = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

type Raw = Record<string, unknown>;

/** 一个价格对象（基础价或某一档）→ 校验后的数；缺 input / output、或任何一个出现的价格字段不合法 → null */
function readRates(
  o: Raw,
  keys: { cacheRead: string; cacheWrite: string },
): Pick<PriceEntry, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> | null {
  const input = price(o.input);
  const output = price(o.output);
  if (input === undefined || output === undefined) return null;
  const out: Pick<PriceEntry, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> = { input, output };
  for (const [k, field] of [
    [keys.cacheRead, 'cacheRead'],
    [keys.cacheWrite, 'cacheWrite'],
  ] as const) {
    if (o[k] === undefined) continue;
    const v = price(o[k]);
    if (v === undefined) return null;
    out[field] = v;
  }
  return out;
}

function readTiers(
  raw: unknown,
  keys: { cacheRead: string; cacheWrite: string },
  sizeOf: (t: Raw) => unknown,
): PriceTier[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const tiers: PriceTier[] = [];
  const seen = new Set<number>();
  for (const x of raw) {
    const t = obj(x);
    if (!t) return null;
    const size = sizeOf(t);
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || seen.has(size))
      return null;
    seen.add(size);
    const rates = readRates(t, keys);
    if (!rates) return null;
    tiers.push({ size, ...rates });
  }
  return tiers.sort((a, b) => a.size - b.size);
}

/** models.dev 的 cost 对象 → 价格；任何一处不合法都整条丢弃（宁可回退内置价，也不记错价） */
export function readModelsDevCost(cost: unknown): Omit<PriceEntry, 'model'> | null {
  const c = obj(cost);
  if (!c) return null;
  const base = readRates(c, { cacheRead: 'cache_read', cacheWrite: 'cache_write' });
  if (!base) return null;
  const tiers = readTiers(c.tiers, { cacheRead: 'cache_read', cacheWrite: 'cache_write' }, (t) => {
    const tier = obj(t.tier);
    return tier && (tier.type === undefined || tier.type === 'context') ? tier.size : undefined;
  });
  if (!tiers) return null;
  return { ...base, ...(tiers.length ? { tiers } : {}) };
}

export interface ExtractResult {
  entries: PriceEntry[];
  /** 因数据不合法 / 重复 / 已下架被丢弃的模型数 */
  skipped: number;
}

const builtinHas = (name: string): boolean =>
  BUILTIN_PRICES.some((e) => {
    const key = normalizeModel(e.model);
    return name === key || (name.startsWith(key) && VERSION_SUFFIX.test(name.slice(key.length)));
  });

/** models.dev 的 api.json → 覆盖层条目（纯函数） */
export function extractPrices(api: unknown): ExtractResult {
  const root = obj(api);
  const live = new Map<string, PriceEntry>();
  const deprecated = new Map<string, PriceEntry>();
  let skipped = 0;
  if (!root) return { entries: [], skipped };
  for (const prov of FIRST_PARTY) {
    const models = obj(obj(root[prov.id])?.models);
    if (!models) continue;
    for (const [id, raw] of Object.entries(models)) {
      const m = obj(raw);
      const key = normalizeModel(typeof m?.id === 'string' ? m.id : id);
      if (!m || !key || (prov.only && !prov.only.test(key))) continue;
      const cost = readModelsDevCost(m.cost);
      if (!cost) {
        skipped++;
        continue;
      }
      const entry: PriceEntry = {
        model: key,
        ...cost,
        ...(typeof m.name === 'string' && m.name ? { label: m.name } : {}),
      };
      const target = m.status === 'deprecated' ? deprecated : live;
      if (target.has(key)) skipped++;
      else target.set(key, entry);
    }
  }
  // 已下架的模型：不覆盖内置（含前缀匹配），也不压过同名的在售条目；内置里没有的才补进来（给老日志定价）
  for (const [key, e] of deprecated) {
    if (live.has(key) || builtinHas(key)) skipped++;
    else live.set(key, e);
  }
  return { entries: [...live.values()], skipped };
}

/** 读缓存文件里的条目时的再校验（文件可能被改坏 / 来自旧版本） */
export function sanitizeSyncedEntries(raw: unknown): PriceEntry[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, PriceEntry>();
  for (const x of raw) {
    const o = obj(x);
    const model = typeof o?.model === 'string' ? normalizeModel(o.model) : '';
    if (!o || !model || out.has(model)) continue;
    const base = readRates(o, { cacheRead: 'cacheRead', cacheWrite: 'cacheWrite' });
    const tiers = readTiers(
      o.tiers,
      { cacheRead: 'cacheRead', cacheWrite: 'cacheWrite' },
      (t) => t.size,
    );
    if (!base || !tiers) continue;
    out.set(model, {
      model,
      ...base,
      ...(tiers.length ? { tiers } : {}),
      ...(typeof o.label === 'string' && o.label ? { label: o.label } : {}),
    });
  }
  return [...out.values()];
}

export interface PriceSyncState {
  /** 覆盖层里的模型数（0 = 没同步过） */
  count: number;
  /** 上次成功下载的时间（ms；0 = 从未） */
  fetchedAt: number;
  /** 上次与服务器核对的时间（含 304 未变化）；0 = 从未 */
  checkedAt: number;
  /** 价格表日期 YYYY-MM-DD（取服务器响应的 Last-Modified / Date，没有就用下载日） */
  tableDate: string;
}

export type PriceSyncFailure = 'network' | 'timeout' | 'http' | 'invalid' | 'too-large' | 'busy';

export type PriceSyncResult =
  | { ok: true; status: 'updated' | 'not-modified'; count: number; skipped: number }
  | { ok: false; reason: PriceSyncFailure; httpStatus?: number };

interface CacheFile {
  v: 1;
  etag: string | null;
  fetchedAt: number;
  checkedAt: number;
  tableDate: string;
  entries: PriceEntry[];
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PriceSyncDeps {
  /** userData/usage */
  root: string;
  now?: () => number;
  /** 测试注入；默认全局 fetch */
  fetchImpl?: FetchLike;
  logger?: { warn(m: string, d?: unknown): void };
}

const dateOnly = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class PriceSync {
  private readonly file: string;
  private cache: CacheFile | null = null;
  private running = false;
  /** 覆盖层内容变化计数（价格缓存失效用） */
  private ver = 0;

  constructor(private readonly d: PriceSyncDeps) {
    this.file = path.join(d.root, 'price-sync.json');
    this.load();
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private load(): void {
    try {
      const st = fs.statSync(this.file);
      if (st.size > MAX_BODY_BYTES) return;
      const j = obj(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      if (!j) return;
      const entries = sanitizeSyncedEntries(j.entries);
      if (!entries.length) return;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
      this.cache = {
        v: 1,
        etag: typeof j.etag === 'string' && j.etag ? j.etag : null,
        fetchedAt: n(j.fetchedAt),
        checkedAt: n(j.checkedAt),
        tableDate: typeof j.tableDate === 'string' ? j.tableDate : '',
        entries,
      };
    } catch {
      /* 没同步过 / 文件损坏：回退内置表 */
    }
  }

  /** 覆盖层条目（没同步过 = 空数组） */
  entries(): PriceEntry[] {
    return this.cache?.entries ?? [];
  }

  version(): number {
    return this.ver;
  }

  state(): PriceSyncState {
    const c = this.cache;
    return {
      count: c?.entries.length ?? 0,
      fetchedAt: c?.fetchedAt ?? 0,
      checkedAt: c?.checkedAt ?? 0,
      tableDate: c?.tableDate ?? '',
    };
  }

  /** 清掉同步缓存，回退内置表 */
  reset(): void {
    this.cache = null;
    this.ver++;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* 忽略 */
    }
  }

  private save(): void {
    if (!this.cache) return;
    try {
      fs.mkdirSync(this.d.root, { recursive: true });
      writePrivateFileAtomic(this.file, JSON.stringify(this.cache));
    } catch (e) {
      this.d.logger?.warn('price sync cache write failed', String(e));
    }
  }

  /** 只在用户点击时调用。失败不动已有缓存。 */
  async sync(): Promise<PriceSyncResult> {
    if (this.running) return { ok: false, reason: 'busy' };
    this.running = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Accept-Encoding': 'br, gzip',
      };
      if (this.cache?.etag) headers['If-None-Match'] = this.cache.etag;
      const doFetch: FetchLike = this.d.fetchImpl ?? ((u, i) => fetch(u, i));
      let res: Response;
      try {
        res = await doFetch(PRICE_SYNC_URL, {
          method: 'GET',
          headers,
          redirect: 'follow',
          credentials: 'omit',
          signal: ctl.signal,
        });
      } catch (e) {
        const aborted = ctl.signal.aborted || (e as { name?: string })?.name === 'AbortError';
        this.d.logger?.warn('price sync failed', String(e));
        return { ok: false, reason: aborted ? 'timeout' : 'network' };
      }
      const now = this.now();
      if (res.status === 304 && this.cache) {
        this.cache.checkedAt = now;
        this.save();
        this.ver++;
        return { ok: true, status: 'not-modified', count: this.cache.entries.length, skipped: 0 };
      }
      if (!res.ok) return { ok: false, reason: 'http', httpStatus: res.status };
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > MAX_BODY_BYTES) return { ok: false, reason: 'too-large' };
      let body: ArrayBuffer;
      try {
        body = await res.arrayBuffer();
      } catch (e) {
        this.d.logger?.warn('price sync body failed', String(e));
        return { ok: false, reason: ctl.signal.aborted ? 'timeout' : 'network' };
      }
      if (body.byteLength > MAX_BODY_BYTES) return { ok: false, reason: 'too-large' };
      let api: unknown;
      try {
        api = JSON.parse(Buffer.from(body).toString('utf8'));
      } catch {
        return { ok: false, reason: 'invalid' };
      }
      const { entries, skipped } = extractPrices(api);
      if (entries.length < MIN_ENTRIES) return { ok: false, reason: 'invalid' };
      const lm = Date.parse(res.headers.get('last-modified') ?? '');
      const dh = Date.parse(res.headers.get('date') ?? '');
      this.cache = {
        v: 1,
        etag: res.headers.get('etag') || null,
        fetchedAt: now,
        checkedAt: now,
        tableDate: dateOnly(Number.isFinite(lm) ? lm : Number.isFinite(dh) ? dh : now),
        entries,
      };
      this.ver++;
      this.save();
      return { ok: true, status: 'updated', count: entries.length, skipped };
    } finally {
      clearTimeout(timer);
      this.running = false;
    }
  }
}
