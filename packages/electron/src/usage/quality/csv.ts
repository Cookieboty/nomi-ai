/**
 * 模型质量导出 CSV（请求明细 / 分组对比表）。纯函数。
 * 单元格按 RFC 4180 转义；以 = + - @ 开头的文本前加 '，防止表格软件当公式执行。
 */
import type { QualityDist, QualityRecord, QualityStats } from '@nomi-ai/types';

type Cell = string | number | boolean | undefined | null;

export function csvCell(v: Cell): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  // BOM：Excel 打开 UTF-8 中文不乱码
  return `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const round = (v: number | undefined, digits = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(digits)) : undefined;

export function requestsCsv(
  items: readonly QualityRecord[],
  labelOf: (dim: 'provider' | 'key', key: string) => string | undefined = () => undefined,
): string {
  const header = [
    'time',
    'layer',
    'client',
    'source',
    'provider',
    'key',
    'model',
    'upstream_model',
    'protocol',
    'resolved',
    'outcome',
    'status',
    'stream',
    'ttfb_ms',
    'ttft_ms',
    'ttft_text_ms',
    'e2e_ms',
    'generation_ms',
    'output_tps',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'cost_usd',
    'attempts',
    'burst',
    'cancel_phase',
    'error',
    'tab_id',
    'trace_id',
  ];
  const rows = items.map((r) => {
    const t = r.timing;
    const gen =
      t.firstContentMs !== undefined && t.lastContentMs !== undefined
        ? t.lastContentMs - t.firstContentMs
        : undefined;
    const out = r.tokens.output ?? 0;
    return [
      new Date(r.ts).toISOString(),
      r.layer,
      r.client,
      r.source,
      r.provider ? (labelOf('provider', r.provider) ?? r.provider) : '',
      r.keyId ? (labelOf('key', `${r.provider ?? ''}\u0000${r.keyId}`) ?? r.keyId) : '',
      r.model,
      r.upstreamModel,
      r.ingress && r.wire ? `${r.ingress}->${r.wire}` : '',
      r.resolved,
      r.outcome,
      r.status,
      r.stream,
      t.headersMs,
      t.firstContentMs,
      t.firstTextMs,
      t.endMs,
      gen,
      gen && gen > 0 && !r.burst ? round(out / (gen / 1000), 1) : undefined,
      r.tokens.input,
      r.tokens.output,
      r.tokens.cacheRead,
      r.tokens.cacheWrite,
      r.tokens.reasoning,
      round(r.cost, 6),
      r.attempts?.length ?? 1,
      r.burst ?? false,
      r.cancelPhase,
      r.errorKind,
      r.tabId,
      r.traceId,
    ];
  });
  return toCsv(header, rows);
}

const pct = (v: number | undefined) => round(v === undefined ? undefined : v * 100, 2);
const d = (x: QualityDist, k: 'p50' | 'p90' | 'p99' | 'mean') => round(x[k], 1);

export function statsCsv(groups: readonly QualityStats[]): string {
  const header = [
    'group',
    'requests',
    'attempts',
    'success_rate_pct',
    'failure_rate_pct',
    'cancel_rate_pct',
    'stream_break_rate_pct',
    'fallback_rate_pct',
    'cache_hit_token_pct',
    'cache_hit_request_pct',
    'burst',
    'ttfb_p50_ms',
    'ttft_p50_ms',
    'ttft_p90_ms',
    'ttft_p99_ms',
    'tpot_p50_ms',
    'e2e_p50_ms',
    'e2e_p90_ms',
    'output_tps_p50',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cost_usd',
  ];
  const rows = groups.map((s) => [
    s.label,
    s.requests,
    s.attempts,
    pct(s.successRate),
    pct(s.failureRate),
    pct(s.cancelRate),
    pct(s.streamBreakRate),
    pct(s.fallbackRate),
    pct(s.cacheHitTokenRate),
    pct(s.cacheHitRequestRate),
    s.burst,
    d(s.ttfb, 'p50'),
    d(s.ttft, 'p50'),
    d(s.ttft, 'p90'),
    d(s.ttft, 'p99'),
    d(s.tpot, 'p50'),
    d(s.e2e, 'p50'),
    d(s.e2e, 'p90'),
    d(s.outputTps, 'p50'),
    s.tokens.input,
    s.tokens.output,
    s.tokens.cacheRead,
    round(s.cost, 6),
  ]);
  return toCsv(header, rows);
}
