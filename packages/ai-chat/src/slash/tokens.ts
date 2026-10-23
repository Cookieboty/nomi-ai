/**
 * /context 与输入栏上下文环用的 token 估算与上下文窗口表。
 *
 * 各部分构成全部是**估算**：没有任何一家 CLI 在非交互模式下公开「当前上下文构成」。
 * 总量优先用主进程算好的 usage.contextTokens（最后一次请求的输入 + 输出）；
 * 每轮的 input / cache / output 是整轮累计（计费口径），一轮多次请求时远大于上下文，不能拿来当总量。
 */
import type { ContextBreakdown } from '../services/harnessClient';
import type { ConvMessage } from '../types/conversation';

import type { ContextCategory } from './types';

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef\u3040-\u30ff]/;

/** 粗略估算：CJK 字符约 1 token / 字，其它约 4 字符 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 常见模型的上下文窗口（公开资料里的标称值，作经验表使用）。
 * 命中不了时回退 128K 并标注「默认值」。用户可以在卡片里看到来源。
 */
const WINDOWS: Array<[RegExp, number]> = [
  // Opus 5.x：Claude Code 上报 modelUsage.contextWindow = 1M（2026-10 实测 claude-opus-5-5）
  [/\[1m\]|[-_]1m\b|gpt-4\.1|gemini|opus-5/i, 1_000_000],
  [/claude|opus|sonnet|haiku/i, 200_000],
  [/gpt-5|codex|\bo[134]\b/i, 400_000],
  [/grok-4|grok-code|grok-3/i, 256_000],
  [/kimi/i, 256_000],
  [/qwen/i, 128_000],
  [/deepseek/i, 128_000],
  [/gpt-4o|gpt-4/i, 128_000],
];

export type ContextWindowSource = 'reported' | 'table' | 'default';

/** reported：CLI 上报的窗口（如 Claude modelUsage.contextWindow），优先于经验表 */
export function contextWindowFor(
  model?: string,
  reported?: number,
): { size: number; source: ContextWindowSource } {
  if (reported && reported > 0) return { size: reported, source: 'reported' };
  if (model) for (const [re, size] of WINDOWS) if (re.test(model)) return { size, source: 'table' };
  return { size: 128_000, source: 'default' };
}

/** 最近一条带 CLI 上报窗口的助手消息的窗口大小 */
export function reportedContextWindow(messages: readonly ConvMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const w = messages[i]!.usage?.contextWindow;
    if (messages[i]!.role === 'assistant' && w && w > 0) return w;
  }
  return undefined;
}

/** 一轮进行中实时上下文占用的占位消息 id（见 withLiveContext） */
export const LIVE_CONTEXT_ID = 'live-context';

/**
 * 把运行中这一轮的实时上下文占用（主线程每次请求 / 压缩后上报）作为一条只带用量的助手消息接在末尾。
 * tokens 为 null（刚压缩、大小未知）时也接一条 contextTokens = 0 的占位：丢弃压缩前的旧值，回退估算。
 */
export function withLiveContext(
  messages: readonly ConvMessage[],
  live: { tokens: number | null; window?: number; breakdown?: ContextBreakdown } | undefined,
): readonly ConvMessage[] {
  if (!live) return messages;
  const at = messages.length ? messages[messages.length - 1]!.at : 0;
  const usage = {
    contextTokens: live.tokens ?? 0,
    ...(live.window ? { contextWindow: live.window } : {}),
    ...(live.breakdown ? { breakdown: live.breakdown } : {}),
  };
  return [...messages, { id: LIVE_CONTEXT_ID, role: 'assistant', text: '', at, usage }];
}

export interface ContextEstimate {
  used: number;
  basis: 'actual' | 'estimate';
  categories: ContextCategory[];
  /** used 是否已超过给定窗口（由调用方结合 window 判断后展示「已超窗口」） */
  overWindow?: boolean;
}

/** 一条消息按类型拆分（估算） */
function splitMessage(m: ConvMessage): Record<'user' | 'assistant' | 'tools' | 'thinking', number> {
  const r = { user: 0, assistant: 0, tools: 0, thinking: 0 };
  if (m.role === 'user') r.user += estimateTokens(m.text);
  else r.assistant += estimateTokens(m.text);
  for (const ev of m.trace ?? []) {
    if (ev.type === 'thinking') r.thinking += estimateTokens(ev.text);
    else if (ev.status === 'start')
      r.tools += estimateTokens(`${ev.name} ${ev.input ?? ev.detail ?? ''}`);
    else r.tools += estimateTokens(ev.output ?? '');
  }
  return r;
}

/**
 * 用量 = 最近一条带 usage.contextTokens 的助手消息的上下文占用 + 之后新增消息的估算；
 * 没有时全部估算（只有整轮累计用量的旧记录 / 不给逐请求用量的 CLI 也走估算，不冒充「真实」）。
 * 分类始终是估算，真实总量比分类之和大的部分记为「系统提示 / 工具定义 / 记忆」。
 * 兜底：真实总量仍比窗口与估算大一个数量级时（错单位等）回退估算，避免环被撑满（见单测）。
 */
/**
 * Claude Code 压缩上下文后，把摘要作为一条用户消息接着发（固定开头）。它之前的消息和真实用量都已不在上下文里。
 */
const COMPACT_SUMMARY = /^\s*This session is being continued from a previous conversation/;

export function isCompactSummary(m: ConvMessage): boolean {
  return m.role === 'user' && COMPACT_SUMMARY.test(m.text);
}

/** 最近一条带 CLI 实际模型名的用量（标签没指定模型时用来查窗口） */
export function reportedModel(messages: readonly ConvMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const model = messages[i]!.usage?.model;
    if (model) return model;
  }
  return undefined;
}

export function estimateContext(
  messages: readonly ConvMessage[],
  labels: { user: string; assistant: string; tools: string; thinking: string; system: string },
  opts?: { windowSize?: number },
): ContextEstimate {
  // 压缩过：只看最后一次压缩摘要及之后的消息（压缩前的真实用量已作废）
  for (let i = messages.length - 1; i > 0; i--) {
    if (isCompactSummary(messages[i]!)) {
      messages = messages.slice(i);
      break;
    }
  }
  const sums = { user: 0, assistant: 0, tools: 0, thinking: 0 };
  let lastActualIdx = -1;
  let actual = 0;
  messages.forEach((m, i) => {
    const s = splitMessage(m);
    sums.user += s.user;
    sums.assistant += s.assistant;
    sums.tools += s.tools;
    sums.thinking += s.thinking;
    const ctx = m.usage?.contextTokens;
    if (m.role === 'assistant' && ctx && ctx > 0) {
      lastActualIdx = i;
      actual = ctx;
    } else if (m.id === LIVE_CONTEXT_ID) {
      // 刚压缩、新大小未知：之前的真实值已经作废
      lastActualIdx = -1;
      actual = 0;
    }
  });
  const est = sums.user + sums.assistant + sums.tools + sums.thinking;
  const categories: ContextCategory[] = [
    { key: 'user', label: labels.user, tokens: sums.user },
    { key: 'assistant', label: labels.assistant, tokens: sums.assistant },
    { key: 'tools', label: labels.tools, tokens: sums.tools },
    { key: 'thinking', label: labels.thinking, tokens: sums.thinking },
  ].filter((c) => c.tokens > 0);
  if (lastActualIdx < 0) return { used: est, basis: 'estimate', categories };
  let after = 0;
  for (let i = lastActualIdx + 1; i < messages.length; i++) {
    const s = splitMessage(messages[i]!);
    after += s.user + s.assistant + s.tools + s.thinking;
  }
  const used = actual + after;
  // CLI 会话记录给了分项（总和 = 真实占用）：直接用，比按 Nomi 落盘的消息估算准
  const bd = messages[lastActualIdx]!.usage?.breakdown;
  if (bd && !after) {
    return {
      used,
      basis: 'actual',
      categories: [
        { key: 'system', label: labels.system, tokens: bd.system },
        { key: 'user', label: labels.user, tokens: bd.user },
        { key: 'assistant', label: labels.assistant, tokens: bd.assistant },
        { key: 'tools', label: labels.tools, tokens: bd.tools },
        { key: 'thinking', label: labels.thinking, tokens: bd.thinking },
      ].filter((c) => c.tokens > 0),
    };
  }
  const win = opts?.windowSize;
  // 累加多步 input / 错单位时，真实用量会比窗口或本地估算大一个数量级——回退估算
  const insane =
    (win != null && win > 0 && used > win * 4 && est > 0 && used > est * 3) ||
    (est > 0 && used > Math.max(est * 8, 2_000_000));
  if (insane) {
    return { used: est, basis: 'estimate', categories };
  }
  if (used < est) {
    // 真实占用比全部消息的估算还小：更早的消息已被压缩出上下文。分类只从最新的消息往前算到 used 为止
    return { used, basis: 'actual', categories: recentCategories(messages, used, labels) };
  }
  const rest = used - est;
  if (rest > 0) categories.unshift({ key: 'system', label: labels.system, tokens: rest });
  return { used, basis: 'actual', categories };
}

/** 从最新的消息往前累加分类估算，到 budget 为止（最后一条按比例截取） */
function recentCategories(
  messages: readonly ConvMessage[],
  budget: number,
  labels: { user: string; assistant: string; tools: string; thinking: string },
): ContextCategory[] {
  const sums = { user: 0, assistant: 0, tools: 0, thinking: 0 };
  let left = budget;
  for (let i = messages.length - 1; i >= 0 && left > 0; i--) {
    const s = splitMessage(messages[i]!);
    const total = s.user + s.assistant + s.tools + s.thinking;
    if (!total) continue;
    const k = Math.min(1, left / total);
    for (const key of ['user', 'assistant', 'tools', 'thinking'] as const) sums[key] += s[key] * k;
    left -= total * k;
  }
  return [
    { key: 'user', label: labels.user, tokens: Math.round(sums.user) },
    { key: 'assistant', label: labels.assistant, tokens: Math.round(sums.assistant) },
    { key: 'tools', label: labels.tools, tokens: Math.round(sums.tools) },
    { key: 'thinking', label: labels.thinking, tokens: Math.round(sums.thinking) },
  ].filter((c) => c.tokens > 0);
}

export function formatTokens(n: number): string {
  const trim = (x: number, digits: number) => x.toFixed(digits).replace(/\.0$/, '');
  if (n >= 1_000_000) return `${trim(n / 1_000_000, n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${trim(n / 1000, n >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  if (!n) return '$0';
  return n < 0.01 ? `<$0.01` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
