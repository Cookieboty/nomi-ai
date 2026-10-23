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
  /** used 是否已超过给定窗口（由调用方结合 window 判断后展示「已超窗口」） */
  overWindow?: boolean;
}

/**
 * 把一轮 HarnessUsage 折成「当前上下文占用」token 数。
 * - 单位必须是 tokens（禁止把字符/字节当 token）。
 * - OpenAI / Grok 风格：cache 已含在 input 内（cache ≤ input）→ 只计 input，避免重复累加。
 * - Anthropic / dsh 风格：input 与 cache 互斥 → input + cache。
 * - 再加 output（本轮回复已进入下一轮上下文）。
 */
export function contextTokensOf(u: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}): number {
  const input = Math.max(0, u.inputTokens ?? 0);
  const cache = Math.max(0, u.cacheReadTokens ?? 0);
  const output = Math.max(0, u.outputTokens ?? 0);
  const prompt = cache > 0 && input > 0 && cache <= input ? input : input + cache;
  return prompt + output;
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
 * 用量 = 最近一次带真实用量的助手消息的「上下文占用」+ 之后新增消息的估算；
 * 没有任何真实用量时全部估算。分类始终是估算，真实总量比分类之和大的部分记为「系统提示 / 工具定义 / 记忆」。
 *
 * 注意：历史多步 agent 若错误地把每步 input 累加，会得到远超窗口的假用量；
 * 此时回退到本地估算，避免环被撑满（见单测）。
 */
export function estimateContext(
  messages: readonly ConvMessage[],
  labels: { user: string; assistant: string; tools: string; thinking: string; system: string },
  opts?: { windowSize?: number },
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
    if (m.role === 'assistant' && u && (u.inputTokens || u.outputTokens || u.cacheReadTokens)) {
      lastActualIdx = i;
      actual = contextTokensOf(u);
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
  const win = opts?.windowSize;
  // 累加多步 input / 错单位时，真实用量会比窗口或本地估算大一个数量级——回退估算
  const insane =
    (win != null && win > 0 && used > win * 4 && est > 0 && used > est * 3) ||
    (est > 0 && used > Math.max(est * 8, 2_000_000));
  if (insane) {
    return { used: est, basis: 'estimate', categories };
  }
  const rest = used - est;
  if (rest > 0) categories.unshift({ key: 'system', label: labels.system, tokens: rest });
  return { used, basis: 'actual', categories };
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
