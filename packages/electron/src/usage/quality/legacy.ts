/**
 * 旧版「最近请求」（userData/gateway/requests.json）条目 → 模型质量记录，首次启动导入一次
 * （docs/design/model-quality.md §4.2）。
 */
import type { QualityRecord } from '@nomi-ai/types';

import type { GatewayRequestEntry } from '../gatewayRequests';

import { modelFamily } from './aggregate';
import { cleanNotes, deriveOutcome } from './fromGateway';

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
  const notes = cleanNotes(e.notes);
  if (notes) rec.notes = notes;
  if (e.tabId) rec.tabId = e.tabId;
  if (e.generation) rec.generation = e.generation;
  return rec;
}
