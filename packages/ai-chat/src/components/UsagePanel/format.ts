/** 用量面板的纯格式化 / 换算函数（无 React 依赖，便于单测）。 */
import { getLocale, t } from '@nomi-ai/ui';

import type { UsageCurrency } from '../../services/usageClient';

/** 1234 → 1.23K，1_234_567 → 1.23M，12_345_678_901 → 12.3B；小于 1000 原样 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const v = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const units: Array<[number, string]> = [
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
  ];
  const fmt = (x: number, unit: string) => {
    const txt = x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2);
    return `${sign}${txt.includes('.') ? txt.replace(/\.?0+$/, '') : txt}${unit}`;
  };
  for (let i = units.length - 1; i >= 0; i--) {
    const [base, unit] = units[i]!;
    if (v < base) continue;
    // 四舍五入后凑满 1000 就进位（999.9K → 1M）
    const next = units[i + 1];
    if (next && Math.round(v / base) >= 1000) return fmt(v / next[0], next[1]);
    return fmt(v / base, unit);
  }
  return `${sign}${Math.round(v)}`;
}

/** 完整千分位（明细表、提示） */
export const formatInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export const currencySymbol = (c: UsageCurrency): string => (c === 'CNY' ? '¥' : '$');

/** USD → 当前币种金额（只换算，不四舍五入） */
export const convert = (usd: number, c: UsageCurrency, cnyPerUsd: number): number =>
  c === 'CNY' ? usd * cnyPerUsd : usd;

/** 金额展示：<0.01 显示 <$0.01；<1 保留 3~4 位；其余 2 位 */
export function formatMoney(usd: number, c: UsageCurrency, cnyPerUsd: number): string {
  const v = convert(usd, c, cnyPerUsd);
  const s = currencySymbol(c);
  if (v === 0) return `${s}0.00`;
  if (v < 0.01) return `<${s}0.01`;
  if (v < 1) return `${s}${v.toFixed(3)}`;
  if (v < 1000) return `${s}${v.toFixed(2)}`;
  return `${s}${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** 会话累计用量一行字：「累计 1.2K Token · $0.05」；未定价不编造金额 */
export function sessionUsageText(
  u: { tokens: number; costUsd: number | null; unpriced: boolean },
  c: UsageCurrency,
  cnyPerUsd: number,
): string {
  const tokens = t('累计 {0} Token', formatTokens(u.tokens));
  if (u.costUsd == null) return [tokens, t('未定价')].join(' · ');
  const cost = formatMoney(u.costUsd, c, cnyPerUsd);
  return [tokens, u.unpriced ? t('{0}（部分模型未定价）', cost) : cost].join(' · ');
}

/** 单价展示（USD / 1M tokens）：保留有效位，去掉多余 0 */
export function formatPrice(n: number | undefined): string {
  if (n == null) return '—';
  return String(Number(n.toFixed(4)));
}

/** 环比：prev=0 时无意义，返回 null */
export function changePct(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null;
  return ((cur - prev) / prev) * 100;
}

export function formatPct(p: number): string {
  const a = Math.abs(p);
  return `${p > 0 ? '+' : p < 0 ? '-' : ''}${a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`;
}

/** 占比（0~1）→ 百分数文本 */
export function share(part: number, total: number): string {
  if (!(total > 0)) return '0%';
  const p = (part / total) * 100;
  return `${p < 1 && p > 0 ? '<1' : p.toFixed(p >= 10 ? 0 : 1)}%`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 趋势图横轴标签：小时桶 → 14:00；日桶 → 10-16 */
export function formatBucket(ts: number, bucket: 'hour' | 'day'): string {
  const d = new Date(ts);
  return bucket === 'hour'
    ? `${pad(d.getHours())}:00`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 热力图格子 → 5 档强度（0 = 无数据）。按非零日的分位数分档，避免一个极值把其余压成同色。 */
export function heatLevels(values: number[]): (v: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]!;
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);
}

/** 来源 id 的展示名；未知来源原样返回 */
export const sourceLabel = (id: string, labels: Record<string, string>): string =>
  t(labels[id] ?? id);

export type DetailRangeId = 'today' | '7d' | '30d' | '90d' | 'year';
export const DETAIL_DAYS: Record<DetailRangeId, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  year: 365,
};

/** 本地自然日起点 */
export function dayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 预设范围 → [from, to)：含今天在内的最近 N 个自然日（以本地时区为准） */
export function presetRange(id: DetailRangeId, now: number): { from: number; to: number } {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  return {
    from: new Date(y, m, day - (DETAIL_DAYS[id] - 1)).getTime(),
    to: new Date(y, m, day + 1).getTime(),
  };
}

/** YYYY-MM-DD（本地日）→ [当日 0 点, 次日 0 点) */
export function dateRange(date: string): { from: number; to: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() };
}

/** 列表分隔符：中文用顿号，英文用逗号 */
export const listSep = (): string => (getLocale() === 'en' ? ', ' : '、');

/** 额度窗口名：300 分钟 → 5 小时窗口，10080 → 每周窗口；未知长度用 primary / secondary 兜底 */
export function quotaWindowLabel(id: string, minutes?: number): string {
  if (!minutes) return id === 'secondary' ? t('长周期窗口') : t('短周期窗口');
  if (minutes === 10080) return t('每周窗口');
  if (minutes < 60) return t('{0} 分钟窗口', Math.round(minutes));
  if (minutes < 1440) return t('{0} 小时窗口', Number((minutes / 60).toFixed(1)));
  return t('{0} 天窗口', Number((minutes / 1440).toFixed(1)));
}

/** 距重置还有多久：「约 2 小时后重置」 */
export function resetText(resetAt: number, now: number): string {
  const d = Math.max(0, resetAt - now);
  if (d < 3_600_000) return t('约 {0} 分钟后重置', Math.max(1, Math.round(d / 60_000)));
  if (d < 86_400_000) return t('约 {0} 小时后重置', Math.round(d / 3_600_000));
  return t('约 {0} 天后重置', Math.round(d / 86_400_000));
}
