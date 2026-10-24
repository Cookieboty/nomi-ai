/**
 * 网关用量事件 → 模型质量记录（layer 'gateway'，docs/design/model-quality.md §4.1）。
 * 新字段（outcome、timing、attemptsDetail、burst…）由网关逐步补上，这里全部按可选读取：
 * 旧事件没有时从状态码 / 错误文本推出结果，时间只有首个内容与结束。
 * token 统一成「input 不含缓存」（与 gatewayRequests.toEntry 同口径），缓存命中率按
 * 缓存读 ÷（input + 缓存读 + 缓存写）算，不再区分协议族。
 */
import type {
  QualityAttempt,
  QualityOutcome,
  QualityRecord,
  QualityTiming,
  QualityTokens,
} from '@nomi-ai/types';

import { cleanError, type GatewayUsageEventLike } from '../gatewayRequests';

import { modelFamily } from './aggregate';

const OUTCOMES: readonly QualityOutcome[] = [
  'ok',
  'client-cancel',
  'auth',
  'rate-limit',
  'upstream-5xx',
  'first-byte-timeout',
  'pre-commit-error',
  'stream-break',
  'idle-timeout',
  'protocol-violation',
  'repetition-stop',
  'request-rejected',
  'gateway-error',
  'cli-error',
  'cli-exit',
];

/** 网关新增的质量字段（全部可选；旧事件没有） */
export interface GatewayQualityFields {
  outcome?: string;
  cancelPhase?: string;
  timing?: Partial<QualityTiming>;
  attemptsDetail?: unknown[];
  burst?: boolean;
  stream?: boolean;
  reasoning?: boolean;
  mode?: string;
  upstreamModel?: string;
}

export type GatewayQualityEvent = GatewayUsageEventLike & GatewayQualityFields;

const BURST_MAX_GEN_MS = 100;
const BURST_MIN_OUTPUT = 20;

const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const ms = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
const str = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

export const isOutcome = (v: unknown): v is QualityOutcome =>
  typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);

/** 旧事件没有 outcome：按状态码与错误文本推断 */
export function deriveOutcome(status: number, error?: string, hasProvider = true): QualityOutcome {
  if (status > 0 && status < 400 && !error) return 'ok';
  if (status === 499) return 'client-cancel';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 504 || /首字|first.?byte|没有响应/i.test(error ?? '')) return 'first-byte-timeout';
  if (/没有任何输出|idle/i.test(error ?? '')) return 'idle-timeout';
  if (/结束标记|上游中断|断开/.test(error ?? '')) return 'stream-break';
  if (/复读|repetition/i.test(error ?? '')) return 'repetition-stop';
  if ([400, 404, 413, 422].includes(status)) return 'request-rejected';
  if (status >= 500) return hasProvider ? 'upstream-5xx' : 'gateway-error';
  if (status > 0 && status < 400) return 'pre-commit-error';
  return hasProvider ? 'upstream-5xx' : 'gateway-error';
}

function timingOf(e: GatewayQualityEvent): QualityTiming {
  const t = e.timing ?? {};
  const endMs = ms(t.endMs) ?? ms(e.ms) ?? 0;
  const out: QualityTiming = { endMs };
  const set = (k: Exclude<keyof QualityTiming, 'endMs'>, v: unknown) => {
    const x = ms(v);
    if (x !== undefined && x <= Math.max(endMs, x)) out[k] = x;
  };
  set('headersMs', t.headersMs);
  set('firstContentMs', t.firstContentMs ?? e.firstByteMs);
  set('firstTextMs', t.firstTextMs);
  set('lastContentMs', t.lastContentMs);
  return out;
}

function tokensOf(e: GatewayUsageEventLike): QualityTokens {
  const u = e.usage ?? {};
  const cacheRead = pos(u.cacheReadTokens);
  const raw = pos(u.inputTokens);
  // Anthropic Messages 上游的 input 不含缓存读写；OpenAI / Gemini 的含缓存读，要减掉
  const input = e.wire === 'messages' ? raw : Math.max(0, raw - cacheRead);
  const out: QualityTokens = {};
  if (input) out.input = input;
  if (pos(u.outputTokens)) out.output = pos(u.outputTokens);
  if (cacheRead) out.cacheRead = cacheRead;
  if (pos(u.cacheWriteTokens)) out.cacheWrite = pos(u.cacheWriteTokens);
  if (pos(u.reasoningTokens)) out.reasoning = pos(u.reasoningTokens);
  return out;
}

function attemptsOf(list: unknown[] | undefined): QualityAttempt[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: QualityAttempt[] = [];
  for (const raw of list.slice(0, 16)) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const provider = str(a.provider);
    const model = str(a.model);
    if (!provider || !model) continue;
    const status = typeof a.status === 'number' ? Math.trunc(a.status) : undefined;
    const outcome = isOutcome(a.outcome)
      ? a.outcome
      : deriveOutcome(status ?? 0, str(a.error ?? a.errorKind));
    const att: QualityAttempt = { provider, model, outcome, ms: ms(a.ms) ?? 0 };
    const keyId = str(a.keyId);
    if (keyId) att.keyId = keyId;
    const wire = str(a.upstreamWire ?? a.wire, 32);
    if (wire) att.upstreamWire = wire;
    if (status !== undefined) att.status = status;
    const headersMs = ms(a.headersMs);
    if (headersMs !== undefined) att.headersMs = headersMs;
    const errorKind = str(a.errorKind, 80);
    if (errorKind) att.errorKind = errorKind;
    out.push(att);
  }
  return out.length ? out : undefined;
}

export interface FromGatewayOptions {
  id: string;
  /** 费用（USD）；未定价返回 undefined */
  cost?: (model: string, tokens: QualityTokens) => number | undefined;
}

export function fromGateway(e: GatewayQualityEvent, o: FromGatewayOptions): QualityRecord {
  const status = Math.trunc(pos(e.status));
  const provider = str(e.provider);
  const error = cleanError(e.error);
  const outcome = isOutcome(e.outcome) ? e.outcome : deriveOutcome(status, error, !!provider);
  const timing = timingOf(e);
  const tokens = tokensOf(e);
  const client = str(e.client, 32) ?? 'unknown';
  const model = str(e.model);
  const upstreamModel = str(e.upstreamModel);
  const stream = e.stream ?? false;
  const rec: QualityRecord = {
    id: o.id,
    layer: 'gateway',
    ts: pos(e.startedAt),
    client,
    source: client === 'nomi' ? 'nomi' : 'thirdParty',
    stream,
    outcome,
    status,
    timing,
    tokens,
  };
  if (provider) rec.provider = provider;
  const keyId = str(e.keyId);
  if (keyId) rec.keyId = keyId;
  if (model) rec.model = model;
  if (upstreamModel) rec.upstreamModel = upstreamModel;
  const family = modelFamily(upstreamModel ?? model);
  if (family) rec.modelFamily = family;
  const ingress = str(e.ingress, 32);
  if (ingress) rec.ingress = ingress;
  const wire = str(e.wire, 32);
  if (wire) rec.wire = wire;
  if (e.mode === 'passthrough' || e.mode === 'convert') rec.mode = e.mode;
  else if (ingress && wire) rec.mode = ingress === wire ? 'passthrough' : 'convert';
  const resolved = str(e.resolved, 32);
  if (resolved) rec.resolved = resolved;
  if (typeof e.reasoning === 'boolean') rec.reasoning = e.reasoning;
  else if (tokens.reasoning) rec.reasoning = true;
  if (outcome === 'client-cancel')
    rec.cancelPhase =
      e.cancelPhase === 'during' || e.cancelPhase === 'before-first'
        ? e.cancelPhase
        : timing.firstContentMs !== undefined
          ? 'during'
          : 'before-first';
  if (error && outcome !== 'ok') rec.errorKind = error.slice(0, 160);
  const attempts = attemptsOf(e.attemptsDetail);
  if (attempts) rec.attempts = attempts;
  const burst =
    typeof e.burst === 'boolean'
      ? e.burst
      : stream &&
        (tokens.output ?? 0) >= BURST_MIN_OUTPUT &&
        timing.firstContentMs !== undefined &&
        timing.lastContentMs !== undefined &&
        timing.lastContentMs - timing.firstContentMs < BURST_MAX_GEN_MS;
  if (burst) rec.burst = true;
  if (typeof e.traceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.traceId))
    rec.traceId = e.traceId;
  const notes = cleanNotes(e.notes);
  if (notes) rec.notes = notes;
  if (typeof e.tabId === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(e.tabId)) rec.tabId = e.tabId;
  if (Number.isInteger(e.generation) && e.generation! > 0) rec.generation = e.generation;
  const priceModel = upstreamModel ?? family ?? model;
  if (o.cost && priceModel) {
    const c = o.cost(priceModel, tokens);
    if (typeof c === 'number' && Number.isFinite(c)) rec.cost = c;
  }
  return rec;
}

/** 校验从磁盘读回的记录（字段齐全、类型正确）；坏行返回 null */
export function sanitizeRecord(v: unknown): QualityRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as QualityRecord;
  if (typeof r.id !== 'string' || (r.layer !== 'gateway' && r.layer !== 'cli')) return null;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null;
  if (typeof r.client !== 'string' || !isOutcome(r.outcome)) return null;
  if (!r.timing || typeof r.timing.endMs !== 'number') return null;
  if (!r.tokens || typeof r.tokens !== 'object') return null;
  if (r.source !== 'nomi' && r.source !== 'official' && r.source !== 'thirdParty') return null;
  return r;
}

/** 网关修正备注：网关自己生成的短文本，限条数与长度 */
export function cleanNotes(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .slice(0, 8)
    .map((x) => x.trim().slice(0, 120));
  return out.length ? out : undefined;
}
