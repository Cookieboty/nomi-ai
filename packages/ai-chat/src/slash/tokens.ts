/**
 * /context 用的 token 估算与上下文窗口表。
 *
 * 全部是**估算**：没有任何一家 CLI 在非交互模式下公开「当前上下文构成」，
 * 所以这里只做两件事：① 优先用最近一次请求返回的真实用量作为总量；
 * ② 按消息类型粗估各部分占比，并在界面上明确标注「估算」。
 */
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
  [/\[1m\]|[-_]1m\b|gpt-4\.1|gemini/i, 1_000_000],
  [/claude|opus|sonnet|haiku/i, 200_000],
  [/gpt-5|codex|\bo[134]\b/i, 400_000],
  [/grok-4|grok-code|grok-3/i, 256_000],
  [/kimi/i, 256_000],
  [/qwen/i, 128_000],
  [/deepseek/i, 128_000],
  [/gpt-4o|gpt-4/i, 128_000],
];

export function contextWindowFor(model?: string): { size: number; source: 'table' | 'default' } {
  if (model) for (const [re, size] of WINDOWS) if (re.test(model)) return { size, source: 'table' };
  return { size: 128_000, source: 'default' };
}

export interface ContextEstimate {
  used: number;
  basis: 'actual' | 'estimate';
  categories: ContextCategory[];
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
 * 用量 = 最近一次带真实用量的助手消息（输入 + 缓存读取 + 输出）+ 之后新增消息的估算；
 * 没有任何真实用量时全部估算。分类始终是估算，真实总量比分类之和大的部分记为「系统提示 / 工具定义 / 记忆」。
 */
export function estimateContext(
  messages: readonly ConvMessage[],
  labels: { user: string; assistant: string; tools: string; thinking: string; system: string },
): ContextEstimate {
  const sums = { user: 0, assistant: 0, tools: 0, thinking: 0 };
  let lastActualIdx = -1;
  let actual = 0;
  messages.forEach((m, i) => {
    const s = splitMessage(m);
    sums.user += s.user;
    sums.assistant += s.assistant;
    sums.tools += s.tools;
    sums.thinking += s.thinking;
    const u = m.usage;
    if (m.role === 'assistant' && u && (u.inputTokens || u.outputTokens)) {
      lastActualIdx = i;
      actual = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.outputTokens ?? 0);
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
  const rest = used - est;
  if (rest > 0) categories.unshift({ key: 'system', label: labels.system, tokens: rest });
  return { used, basis: 'actual', categories };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  if (!n) return '$0';
  return n < 0.01 ? `<$0.01` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
