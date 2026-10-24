/**
 * 「最近请求」与模型质量记录的互转（docs/design/model-quality.md §4.2 迁移）：
 * - 旧的 userData/gateway/requests.json 条目一次性导入质量账本；
 * - 「最近请求」兼容视图（ai:usage:gateway-requests）从质量账本取最近的记录，转回旧条目结构。
 */
import type { QualityRecord } from '@nomi-ai/types';

import { MODEL_RESOLUTIONS, type GatewayRequestEntry } from '../gatewayRequests';

import { modelFamily } from './aggregate';
import { deriveOutcome } from './fromGateway';

/** 旧条目 → 网关层质量记录（没有流式细节：只有首字节与总耗时） */
export function recordFromEntry(e: GatewayRequestEntry): QualityRecord {
  const rec: QualityRecord = {
    id: `legacy-${e.id}`,
    layer: 'gateway',
    ts: e.ts,
    client: e.client,
    source: e.client === 'nomi' ? 'nomi' : 'thirdParty',
    stream: false,
    outcome: deriveOutcome(e.status, e.error, !!e.providerId),
    status: e.status,
    timing: {
      endMs: e.ms,
      ...(typeof e.firstByteMs === 'number' ? { firstContentMs: e.firstByteMs } : {}),
    },
    tokens: {
      ...(e.input ? { input: e.input } : {}),
      ...(e.output ? { output: e.output } : {}),
      ...(e.cacheRead ? { cacheRead: e.cacheRead } : {}),
      ...(e.cacheWrite ? { cacheWrite: e.cacheWrite } : {}),
      ...(e.reasoning ? { reasoning: e.reasoning } : {}),
    },
  };
  if (e.providerId) rec.provider = e.providerId;
  if (e.keyId) rec.keyId = e.keyId;
  if (e.model) {
    rec.model = e.model;
    const f = modelFamily(e.model);
    if (f) rec.modelFamily = f;
  }
  rec.ingress = e.ingress;
  if (e.wire) {
    rec.wire = e.wire;
    rec.mode = e.ingress === e.wire ? 'passthrough' : 'convert';
  }
  if (e.resolved) rec.resolved = e.resolved;
  if (e.error && rec.outcome !== 'ok') rec.errorKind = e.error.slice(0, 160);
  if (e.traceId) rec.traceId = e.traceId;
  if (e.tabId) rec.tabId = e.tabId;
  if (e.generation) rec.generation = e.generation;
  return rec;
}

/** 质量记录 → 旧条目结构（「最近请求」兼容视图） */
export function entryFromRecord(
  r: QualityRecord,
  names?: (providerId?: string, keyId?: string) => { provider?: string; key?: string },
): GatewayRequestEntry {
  const n = names?.(r.provider, r.keyId) ?? {};
  const entry: GatewayRequestEntry = {
    id: r.id,
    ts: r.ts,
    client: r.client,
    ingress: r.ingress ?? 'unknown',
    status: r.status ?? 0,
    ms: r.timing.endMs,
    attempts: Math.max(1, r.attempts?.length ?? 1),
    input: r.tokens.input ?? 0,
    output: r.tokens.output ?? 0,
    cacheRead: r.tokens.cacheRead ?? 0,
    cacheWrite: r.tokens.cacheWrite ?? 0,
  };
  if (r.wire) entry.wire = r.wire;
  if (r.provider) entry.providerId = r.provider;
  const provider = n.provider ?? r.provider;
  if (provider) entry.provider = provider;
  if (r.keyId) entry.keyId = r.keyId;
  if (n.key) entry.key = n.key;
  if (r.model) entry.model = r.model;
  if (r.timing.firstContentMs !== undefined) entry.firstByteMs = r.timing.firstContentMs;
  if (r.tokens.reasoning) entry.reasoning = r.tokens.reasoning;
  if (r.outcome !== 'ok' && r.errorKind) entry.error = r.errorKind;
  if (r.traceId) entry.traceId = r.traceId;
  if (r.tabId) entry.tabId = r.tabId;
  if (r.generation) entry.generation = r.generation;
  const resolved = MODEL_RESOLUTIONS.find((x) => x === r.resolved);
  if (resolved) entry.resolved = resolved;
  return entry;
}
