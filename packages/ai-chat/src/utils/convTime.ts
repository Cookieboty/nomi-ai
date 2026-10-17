/** 会话时间 / 用量展示：按分钟合并时间标签、完整时间、耗时、token 与费用摘要（纯函数） */
import { t } from '@nomi-ai/ui';

import type { HarnessUsage } from '../services/harnessClient';
import type { ConvMessage } from '../types/conversation';

import { formatDuration } from './toolTrace';

const pad = (n: number) => String(n).padStart(2, '0');

/** 同一分钟（含日期）的消息共用一个时间标签 */
export function minuteKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
}

export function formatClock(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const n = new Date(now);
  const same =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (same) return hm;
  const date =
    d.getFullYear() === n.getFullYear()
      ? `${d.getMonth() + 1}-${pad(d.getDate())}`
      : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date} ${hm}`;
}

/** 悬停显示的完整时间：2026-10-16 14:03:27 */
export function formatFullTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/**
 * 每条消息要不要显示时间标签：与上一条同一分钟则省略（相邻消息按分钟合并）。
 * 返回 id → 标签；省略的消息不在表里。
 */
export function timeLabels(
  messages: readonly Pick<ConvMessage, 'id' | 'at'>[],
  now = Date.now(),
): Map<string, string> {
  const out = new Map<string, string>();
  let prev = '';
  for (const m of messages) {
    const key = minuteKey(m.at);
    if (key !== prev) out.set(m.id, formatClock(m.at, now));
    prev = key;
  }
  return out;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return `<$0.01`;
  return `$${usd < 1 ? usd.toFixed(3).replace(/0$/, '') : usd.toFixed(2)}`;
}

export interface TurnSummaryParts {
  duration?: string;
  tokens?: string;
  cost?: string;
}

/** 一轮的耗时 / token / 费用摘要；某项没有数据就不出现（全都没有返回 null） */
export function turnSummary(m: {
  durationMs?: number;
  usage?: HarnessUsage;
}): TurnSummaryParts | null {
  const parts: TurnSummaryParts = {};
  const d = m.durationMs ?? m.usage?.durationMs;
  if (d !== undefined && d >= 0) parts.duration = formatDuration(Math.round(d / 100) * 100);
  const u = m.usage;
  if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
    parts.tokens = t(
      '输入 {0} · 输出 {1}',
      formatTokens(u.inputTokens ?? 0),
      formatTokens(u.outputTokens ?? 0),
    );
  }
  if (u?.costUsd !== undefined) parts.cost = formatCost(u.costUsd);
  return Object.keys(parts).length ? parts : null;
}

/** 完成后的思考块标题：已思考 N 秒（缺时间数据则只显示「已思考」） */
export function thoughtLabel(ms?: number): string {
  if (ms === undefined || ms < 0) return t('已思考');
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return t('已思考 {0} 秒', s);
  return t('已思考 {0} 分 {1} 秒', Math.floor(s / 60), s % 60);
}
