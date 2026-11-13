/**
 * 侧边聊天：对话旁标签区里的临时聊天（见 docs/design/side-tabs-workspace.md）。
 * - 每个会话（主列的会话键）最多一个；内容只在这个窗口的内存里：不进会话列表 / 历史，关掉应用就没了；
 * - 只用 Nomi 自己：走 ai.chat.agentStream，extra.sideChat = true，内核（internal/core/sidechat）把请求收紧成
 *   Nomi 的模型 + 只读工具（不能委派给 Codex / Claude Code 等编程助手、不能改文件 / 跑命令），不挂会话、不冒气泡；
 * - 模型只能从 Nomi 的模型里选（extra.sideChatModel，没选 = 跟 Nomi 对话同一个）；
 * - 带上当前会话的项目（extra.projectId）：项目文件夹里只读。
 */
import { createLogger } from '@nomi-ai/ui';
import { useSyncExternalStore } from 'react';

import {
  composeWithQuotes,
  normalizeQuoteText,
  type SelectionQuote,
} from '../utils/selectionQuote';

import { api, hasTransport } from './api';

const log = createLogger('side-chat');

export interface SideChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** 用户：问题正文（引用另存）；助手：回答 */
  text: string;
  quotes?: SelectionQuote[];
  error?: string;
}

export interface SideChatState {
  messages: SideChatMessage[];
  /** 输入框上待发的引用（「在侧边聊天中提问」带进来的选区） */
  quotes: SelectionQuote[];
  draft: string;
  /** 选的 Nomi 模型（`供应商/模型`）；null = 跟 Nomi 对话同一个 */
  model: string | null;
  /** 正在回答的那一轮 */
  running: { reqId: string; text: string; tool?: string } | null;
}

const EMPTY: SideChatState = { messages: [], quotes: [], draft: '', model: null, running: null };
/** 引用最多带这么多段 */
export const SIDE_CHAT_MAX_QUOTES = 8;

const chats = new Map<string, SideChatState>();
const listeners = new Set<() => void>();
const aborts = new Map<string, AbortController>();
let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

function emit() {
  for (const fn of listeners) fn();
}

function set(scope: string, fn: (s: SideChatState) => SideChatState) {
  const cur = chats.get(scope) ?? EMPTY;
  const next = fn(cur);
  if (next === cur) return;
  chats.set(scope, next);
  emit();
}

export function sideChatState(scope: string): SideChatState {
  return chats.get(scope) ?? EMPTY;
}

export function subscribeSideChat(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSideChat(scope: string): SideChatState {
  return useSyncExternalStore(
    subscribeSideChat,
    () => sideChatState(scope),
    () => EMPTY,
  );
}

/** 「在侧边聊天中提问」：把选区加到输入框上（同一段不重复加） */
export function addSideChatQuote(scope: string, quote: SelectionQuote): void {
  const text = normalizeQuoteText(quote.text);
  if (!text) return;
  set(scope, (s) => {
    if (s.quotes.some((q) => q.text === text && q.source === quote.source)) return s;
    const quotes = [...s.quotes, { ...quote, text }].slice(-SIDE_CHAT_MAX_QUOTES);
    return { ...s, quotes };
  });
}

export function removeSideChatQuote(scope: string, index: number): void {
  set(scope, (s) =>
    index >= 0 && index < s.quotes.length
      ? { ...s, quotes: s.quotes.filter((_, i) => i !== index) }
      : s,
  );
}

export function setSideChatDraft(scope: string, draft: string): void {
  set(scope, (s) => (s.draft === draft ? s : { ...s, draft }));
}

export function setSideChatModel(scope: string, model: string | null): void {
  set(scope, (s) => (s.model === model ? s : { ...s, model }));
}

/** 关掉侧边聊天标签：停下正在回答的一轮，内容丢掉 */
export function discardSideChat(scope: string): void {
  stopSideChat(scope);
  if (chats.delete(scope)) emit();
}

export function stopSideChat(scope: string): void {
  const running = chats.get(scope)?.running;
  aborts.get(scope)?.abort();
  aborts.delete(scope);
  if (running && hasTransport())
    void api.ai.chat.abort({ reqId: running.reqId }).catch(() => undefined);
  set(scope, (s) => {
    if (!s.running) return s;
    const partial = s.running.text.trim();
    const messages = partial
      ? [...s.messages, { id: newId('a'), role: 'assistant' as const, text: partial }]
      : s.messages;
    return { ...s, messages, running: null };
  });
}

type Chunk = { type?: string; content?: unknown; error?: unknown; name?: unknown };

/** 发给内核的消息：Nomi 的系统提示 + 之前几轮 + 这一轮（引用在前） */
export function sideChatRequestMessages(
  system: string | undefined,
  history: readonly SideChatMessage[],
  text: string,
  quotes: readonly SelectionQuote[],
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (system?.trim()) out.push({ role: 'system', content: system });
  for (const m of history) {
    if (m.error && !m.text) continue;
    out.push({
      role: m.role,
      content: m.role === 'user' ? composeWithQuotes(m.quotes ?? [], m.text) : m.text,
    });
  }
  out.push({ role: 'user', content: composeWithQuotes(quotes, text) });
  return out;
}

/** 发送输入框里的问题（连同引用）；正在回答时不发 */
export async function sendSideChat(
  scope: string,
  opts: { projectId?: string | null } = {},
): Promise<void> {
  const cur = sideChatState(scope);
  const text = cur.draft.trim();
  if (cur.running || (!text && !cur.quotes.length)) return;
  const quotes = cur.quotes;
  const history = cur.messages;
  const reqId = newId('side');
  const user: SideChatMessage = {
    id: newId('u'),
    role: 'user',
    text,
    ...(quotes.length ? { quotes } : {}),
  };
  set(scope, (s) => ({
    ...s,
    messages: [...s.messages, user],
    quotes: [],
    draft: '',
    running: { reqId, text: '' },
  }));
  const ctrl = new AbortController();
  aborts.set(scope, ctrl);
  const finish = (patch: Partial<SideChatMessage>) => {
    if (aborts.get(scope) !== ctrl) return;
    aborts.delete(scope);
    set(scope, (s) => {
      if (s.running?.reqId !== reqId) return s;
      const textOut = s.running.text.trim();
      const msg: SideChatMessage = { id: newId('a'), role: 'assistant', text: textOut, ...patch };
      return {
        ...s,
        messages: textOut || msg.error ? [...s.messages, msg] : s.messages,
        running: null,
      };
    });
  };
  try {
    if (!hasTransport()) throw new Error('offline');
    let system: string | undefined;
    try {
      system = await api.persona.systemPrompt();
    } catch (e) {
      log.warn('system prompt unavailable', e);
    }
    const model = sideChatState(scope).model;
    const stream = api.ai.chat.agentStream({
      reqId,
      role: 'chat',
      messages: sideChatRequestMessages(system, history, text, quotes),
      extra: {
        sideChat: true,
        ...(model ? { sideChatModel: model } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      },
    });
    for await (const raw of stream) {
      if (ctrl.signal.aborted) break;
      const c = raw as Chunk;
      if (c.type === 'delta' && typeof c.content === 'string') {
        const delta = c.content;
        set(scope, (s) =>
          s.running?.reqId === reqId
            ? { ...s, running: { ...s.running, text: s.running.text + delta, tool: undefined } }
            : s,
        );
      } else if (c.type === 'tool_call.delta') {
        const name = typeof c.name === 'string' ? c.name : undefined;
        set(scope, (s) =>
          s.running?.reqId === reqId ? { ...s, running: { ...s.running, tool: name ?? '' } } : s,
        );
      } else if (c.type === 'error') {
        throw new Error(typeof c.error === 'string' ? c.error : 'error');
      }
    }
    finish({});
  } catch (error) {
    if (ctrl.signal.aborted) return;
    log.warn('side chat failed', error);
    finish({ error: error instanceof Error ? error.message : String(error) });
  }
}

/** 单测用：清空所有侧边聊天 */
export function resetSideChats(): void {
  for (const c of aborts.values()) c.abort();
  aborts.clear();
  chats.clear();
  emit();
}
