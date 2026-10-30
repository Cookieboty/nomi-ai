/**
 * chatContext —— 多轮对话上下文裁剪（token 预算）。
 *
 * 规则：
 * 1. 所有 `system` 消息原样保留（按出现顺序放在最前），不参与裁剪；
 * 2. 最后一条消息（本轮用户输入）一定保留；若加上 system 后仍超预算，截断其内容；
 * 3. 其余历史从最新往最旧回填，直到超出 `maxTokens` 或 `maxMessages`；
 * 4. 窗口开头若是孤立的 assistant / tool 消息（其对应的 user 已被裁掉），一并丢弃。
 *
 * token 估算是启发式的（CJK 字符 ≈ 1 token，其余 ≈ 4 字符 1 token，每条消息 +4 开销），
 * 只用于预算控制，宁可略微高估。
 */

import type { ChatMessage } from '@nomi-ai/bundle-ig-base';

export interface ContextBudget {
  /** 发送给模型的消息总 token 上限（估算），默认 8000 */
  maxTokens?: number;
  /** 非 system 消息条数上限，默认 50 */
  maxMessages?: number;
}

export const DEFAULT_CONTEXT_BUDGET: Required<ContextBudget> = {
  maxTokens: 8000,
  maxMessages: 50,
};

const MESSAGE_OVERHEAD = 4;
const TRUNCATION_MARK = '…[truncated]';
// CJK 统一表意文字 / 假名 / 谚文 / 全角标点
const WIDE_CHAR =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const wide = text.match(WIDE_CHAR)?.length ?? 0;
  const narrow = text.length - wide;
  return wide + Math.ceil(narrow / 4);
}

export function estimateMessageTokens(m: ChatMessage): number {
  return estimateTokens(m.content ?? '') + MESSAGE_OVERHEAD;
}

/** 把内容截到大约 `tokens` 个 token（保留开头） */
function truncateToTokens(text: string, tokens: number): string {
  if (tokens <= 0) return TRUNCATION_MARK;
  if (estimateTokens(text) <= tokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + TRUNCATION_MARK;
}

export function fitMessagesToBudget(
  messages: readonly ChatMessage[],
  budget: ContextBudget = {},
): ChatMessage[] {
  const maxTokens = budget.maxTokens ?? DEFAULT_CONTEXT_BUDGET.maxTokens;
  const maxMessages = Math.max(1, budget.maxMessages ?? DEFAULT_CONTEXT_BUDGET.maxMessages);

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length === 0) return [...system];

  let used = system.reduce((n, m) => n + estimateMessageTokens(m), 0);

  const last = rest[rest.length - 1]!;
  let lastKept: ChatMessage = last;
  const lastCost = estimateMessageTokens(last);
  if (used + lastCost > maxTokens) {
    lastKept = {
      ...last,
      content: truncateToTokens(last.content, maxTokens - used - MESSAGE_OVERHEAD),
    };
    used += estimateMessageTokens(lastKept);
  } else {
    used += lastCost;
  }

  const window: ChatMessage[] = [lastKept];
  for (let i = rest.length - 2; i >= 0 && window.length < maxMessages; i--) {
    const m = rest[i]!;
    const cost = estimateMessageTokens(m);
    if (used + cost > maxTokens) break;
    used += cost;
    window.unshift(m);
  }

  // 丢弃开头孤立的 assistant / tool 消息（保证窗口以 user 开头，最后一条除外）
  while (window.length > 1 && window[0]!.role !== 'user') window.shift();

  return [...system, ...window];
}
