/**
 * 侧边聊天：对话旁标签区里的临时聊天（见 docs/design/side-tabs-workspace.md）。
 * - 和子任务一样是标签区里的一个标签（SubagentTarget kind 'side-chat'），一个会话里可以同时开好几个，
 *   各自独立（消息、草稿、模型、思考深度），按开的先后编号「侧边聊天 1 / 2 …」；
 * - 内容只在内存里：不进会话列表 / 历史，关掉标签就丢掉，关掉应用就没了；弹到独立窗口 / 放回时经宿主内存交接
 *   （chatWindow.handoffPut / handoffTake，不落盘）；
 * - 只用 Nomi 自己：走 ai.chat.agentStream，extra.sideChat = true，内核（internal/core/sidechat）把请求收紧成
 *   Nomi 的模型 + 只读工具（不能委派给 Codex / Claude Code 等编程助手、不能改文件 / 跑命令），不挂会话、不冒气泡；
 * - 模型 / 思考深度：和主对话同一个选择器（NomiModelSwitch 的 binding），记在这个侧边聊天上；
 *   请求带 extra.sideChatModel（内核换成 "model:<供应商/模型>" 路由）和 extra.reasoningEffort（同主对话）；
 * - 带上当前会话的项目（extra.projectId）：项目文件夹里只读。
 */
import { createLogger, t } from '@nomi-ai/ui';
import { useSyncExternalStore } from 'react';

import type { ConvLive, ConvMessage } from '../types/conversation';
import { chunkToTrace } from '../utils/chunkTrace';
import { quoteMarkdown, type SelectionQuote } from '../utils/selectionQuote';
import { closeOpenCalls } from '../utils/toolTrace';

import { api, hasTransport } from './api';
import { createComposerDraftStore } from './composerDrafts';
import type { HarnessTraceEvent } from './harnessClient';
import { gatewayStateSnapshot, nomiMainRef, refLabel } from './nomiModel';
import { resolveThinkingLevel, thinkingProfileOf } from './thinkingDepth';

const log = createLogger('side-chat');

/** 用户消息上带的图片：data 只在这个窗口内存里（重新生成 / 编辑重发用），交接快照只带缩略图 */
export interface SideChatImage {
  mime: string;
  thumb: string;
  width: number;
  height: number;
  data?: string;
}

export interface SideChatState {
  id: string;
  /** 开它的会话键（标签区按会话分） */
  scope: string;
  /** 这个会话里的第几个（标签名「侧边聊天 N」） */
  seq: number;
  projectId: string | null;
  messages: ConvMessage[];
  /** 选的 Nomi 模型（`供应商/模型`）；null = 跟 Nomi 对话同一个 */
  model: string | null;
  /** 选的思考深度；undefined = 这个模型的默认档 */
  effort?: string;
  /** 正在回答的一轮 */
  running: { reqId: string; live: ConvLive } | null;
  /** 正在回答时排队的问题（这一轮结束后依次发出） */
  queued: string[];
  /** 「在侧边聊天中提问」：往已挂着的输入栏里填的引用（按 nonce 触发） */
  fill: { text: string; nonce: number } | null;
}

export const SIDE_CHAT_PREFIX = 'side-chat:';
export const sideChatDraftKey = (id: string) => `${SIDE_CHAT_PREFIX}${id}`;
/** 所有侧边聊天输入栏的草稿（文字 / 图片 / 附件）：按聊天分开，切标签、重挂载都还在 */
export const sideChatDrafts = createComposerDraftStore();

const chats = new Map<string, SideChatState>();
const listeners = new Set<() => void>();
const aborts = new Map<string, AbortController>();
const mounted = new Map<string, number>();
let version = 0;
let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

function emit() {
  version += 1;
  for (const fn of listeners) fn();
}

function set(id: string, fn: (s: SideChatState) => SideChatState) {
  const cur = chats.get(id);
  if (!cur) return;
  const next = fn(cur);
  if (next === cur) return;
  chats.set(id, next);
  emit();
}

export function sideChatState(id: string): SideChatState | undefined {
  return chats.get(id);
}

export function subscribeSideChat(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSideChat(id: string): SideChatState | undefined {
  return useSyncExternalStore(
    subscribeSideChat,
    () => chats.get(id),
    () => undefined,
  );
}

const byScopeCache = new Map<string, { version: number; list: SideChatState[] }>();
/** 这个会话里的侧边聊天（按编号） */
export function sideChatsIn(scope: string): SideChatState[] {
  const hit = byScopeCache.get(scope);
  if (hit && hit.version === version) return hit.list;
  const list = [...chats.values()].filter((c) => c.scope === scope).sort((a, b) => a.seq - b.seq);
  const same = hit && hit.list.length === list.length && hit.list.every((c, i) => c === list[i]);
  const out = same ? hit.list : list;
  byScopeCache.set(scope, { version, list: out });
  return out;
}

export function useSideChatsIn(scope: string): SideChatState[] {
  return useSyncExternalStore(
    subscribeSideChat,
    () => sideChatsIn(scope),
    () => EMPTY_LIST,
  );
}
const EMPTY_LIST: SideChatState[] = [];

/** 标签名：「侧边聊天 N」 */
export function sideChatName(chat: Pick<SideChatState, 'seq'> | undefined): string {
  return chat ? t('ui.session-workspace.side-chat-title-n', String(chat.seq)) : '';
}

/** 新开一个侧边聊天；quote 放到它的输入栏上 */
export function createSideChat(
  scope: string,
  opts: { projectId?: string | null; quote?: SelectionQuote } = {},
): string {
  const id = newId('sc');
  const n = Math.max(0, ...sideChatsIn(scope).map((c) => c.seq)) + 1;
  chats.set(id, {
    id,
    scope,
    seq: n,
    projectId: opts.projectId ?? null,
    messages: [],
    model: null,
    running: null,
    queued: [],
    fill: null,
  });
  if (opts.quote) appendDraft(id, quoteBlock(opts.quote));
  emit();
  return id;
}

const quoteBlock = (q: SelectionQuote) => `${quoteMarkdown(q)}\n\n`;

function appendDraft(id: string, text: string) {
  const key = sideChatDraftKey(id);
  const cur = sideChatDrafts.read(key);
  sideChatDrafts.write(key, { ...cur, text: cur.text ? `${cur.text}\n\n${text}` : text });
}

/** 输入栏挂着时（标签开着）引用经 fill 填进去；没挂时直接写进草稿，挂上时读到 */
export function markSideChatComposer(id: string): () => void {
  mounted.set(id, (mounted.get(id) ?? 0) + 1);
  return () => {
    const n = (mounted.get(id) ?? 1) - 1;
    if (n <= 0) mounted.delete(id);
    else mounted.set(id, n);
  };
}

/** 「在侧边聊天中提问」：把选区作为引用加到这个侧边聊天的输入栏上 */
export function addSideChatQuote(id: string, quote: SelectionQuote): void {
  if (!chats.has(id)) return;
  const text = quoteBlock(quote);
  if (!mounted.has(id)) {
    appendDraft(id, text);
    emit();
    return;
  }
  set(id, (s) => ({ ...s, fill: { text, nonce: (s.fill?.nonce ?? 0) + 1 } }));
}

export function setSideChatModel(id: string, model: string | null): void {
  set(id, (s) => (s.model === model ? s : { ...s, model }));
}

export function setSideChatEffort(id: string, effort: string | undefined): void {
  set(id, (s) => (s.effort === effort ? s : { ...s, effort }));
}

/** 关掉标签：停下正在回答的一轮，内容丢掉 */
export function discardSideChat(id: string): void {
  stopSideChat(id);
  sideChatDrafts.dropPrivate(sideChatDraftKey(id));
  if (chats.delete(id)) emit();
}

/** 停下这一轮：已生成的部分留下，标成已停止；排队的问题不再发 */
export function stopSideChat(id: string): void {
  const cur = chats.get(id);
  const running = cur?.running;
  aborts.get(id)?.abort();
  aborts.delete(id);
  if (running && hasTransport())
    void api.ai.chat.abort({ reqId: running.reqId }).catch(() => undefined);
  set(id, (s) => {
    if (!s.running) return s.queued.length ? { ...s, queued: [] } : s;
    const msg = finishedMessage(s.running.live, { stopped: true }, s.model);
    return {
      ...s,
      messages: msg ? [...s.messages, msg] : s.messages,
      running: null,
      queued: [],
    };
  });
}

export function removeSideChatQueued(id: string, index: number): void {
  set(id, (s) =>
    index >= 0 && index < s.queued.length
      ? { ...s, queued: s.queued.filter((_, i) => i !== index) }
      : s,
  );
}

const modelLabel = (model: string | null): string | undefined => {
  const state = gatewayStateSnapshot();
  const ref = model ?? nomiMainRef(state);
  return ref ? refLabel(state, ref) : undefined;
};

function finishedMessage(
  live: ConvLive,
  patch: Partial<ConvMessage>,
  model: string | null,
): ConvMessage | null {
  const text = live.text.trim();
  const trace = live.trace?.length
    ? [...live.trace, ...closeOpenCalls(live.trace, Date.now(), t('ui.chat-settings.stopped'))]
    : undefined;
  if (!text && !trace && !patch.error) return null;
  const now = Date.now();
  return {
    id: newId('a'),
    role: 'assistant',
    text: live.text,
    at: now,
    label: 'Nomi',
    ...(modelLabel(model) ? { model: modelLabel(model) } : {}),
    ...(live.startedAt ? { durationMs: now - live.startedAt } : {}),
    ...(trace ? { trace } : {}),
    ...patch,
  };
}

export const imagesOf = (m: ConvMessage): SideChatImage[] =>
  ((m.raw as { images?: SideChatImage[] } | undefined)?.images ?? []).filter(
    (i) => i && typeof i.thumb === 'string',
  );

type ReqMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: Array<{ mime: string; data: string }>;
};

/** 发给内核的消息：Nomi 的系统提示 + 之前几轮（出错的不带；图片只在这一轮发原图） + 这一轮 */
export function sideChatRequestMessages(
  system: string | undefined,
  history: readonly ConvMessage[],
  user: ConvMessage,
): ReqMessage[] {
  const out: ReqMessage[] = [];
  if (system?.trim()) out.push({ role: 'system', content: system.trim() });
  for (const m of history) {
    if (m.error || (!m.text.trim() && !imagesOf(m).length)) continue;
    const n = m.role === 'user' ? imagesOf(m).length : 0;
    const tag = n ? t('ui.chat-settings.images-were-attached-earlier', n) : '';
    out.push({ role: m.role, content: tag + m.text });
  }
  const images = imagesOf(user).flatMap((i) => (i.data ? [{ mime: i.mime, data: i.data }] : []));
  out.push({ role: 'user', content: user.text, ...(images.length ? { images } : {}) });
  return out;
}

type Chunk = { type: string; [k: string]: unknown };

/** 这个侧边聊天这一轮的思考深度：选过且在这个模型的档位里就用它，否则这个模型的默认档 */
export function sideChatEffort(chat: Pick<SideChatState, 'model' | 'effort'>): string | undefined {
  const state = gatewayStateSnapshot();
  return resolveThinkingLevel(
    chat.effort,
    thinkingProfileOf(state, chat.model ?? nomiMainRef(state)),
  );
}

async function runTurn(id: string, user: ConvMessage, history: ConvMessage[]): Promise<void> {
  const reqId = newId('side');
  const startedAt = Date.now();
  set(id, (s) => ({
    ...s,
    messages: [...history, user],
    running: { reqId, live: { text: '', trace: [], startedAt } },
  }));
  const ctrl = new AbortController();
  aborts.set(id, ctrl);
  const patchLive = (fn: (l: ConvLive) => ConvLive) =>
    set(id, (s) =>
      s.running?.reqId === reqId ? { ...s, running: { reqId, live: fn(s.running.live) } } : s,
    );
  const finish = (patch: Partial<ConvMessage>) => {
    if (aborts.get(id) !== ctrl) return;
    aborts.delete(id);
    set(id, (s) => {
      if (s.running?.reqId !== reqId) return s;
      const msg = finishedMessage(s.running.live, patch, s.model);
      return { ...s, messages: msg ? [...s.messages, msg] : s.messages, running: null };
    });
    // 排队的下一条
    const next = chats.get(id)?.queued[0];
    if (next !== undefined) {
      set(id, (s) => ({ ...s, queued: s.queued.slice(1) }));
      void sendSideChat(id, next);
    }
  };
  try {
    if (!hasTransport())
      throw new Error(t('ui.session-workspace.side-chat-failed', 'no transport'));
    let system: string | undefined;
    try {
      system = await api.persona.systemPrompt();
    } catch (e) {
      log.warn('system prompt unavailable', e);
    }
    const chat = chats.get(id);
    if (!chat || ctrl.signal.aborted) return;
    const effort = sideChatEffort(chat);
    const stream = api.ai.chat.agentStream({
      reqId,
      role: 'chat',
      messages: sideChatRequestMessages(system, history, user),
      extra: {
        sideChat: true,
        ...(chat.model ? { sideChatModel: chat.model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(chat.projectId ? { projectId: chat.projectId } : {}),
      },
    });
    for await (const raw of stream) {
      if (ctrl.signal.aborted) break;
      const c = raw as Chunk;
      if (!c || typeof c !== 'object') continue;
      const now = Date.now();
      if (c.type === 'delta' && typeof c.content === 'string') {
        const delta = c.content;
        patchLive((l) => ({
          ...l,
          text: l.text + delta,
          thinking: false,
          firstEventAt: l.firstEventAt ?? now,
        }));
      } else if (c.type === 'error') {
        throw new Error(typeof c.error === 'string' ? c.error : 'error');
      } else {
        const ev: HarnessTraceEvent | null = chunkToTrace(c, now);
        if (c.type === 'reasoning')
          patchLive((l) => ({
            ...l,
            thinking: c.phase !== 'end',
            firstEventAt: l.firstEventAt ?? now,
          }));
        if (ev)
          patchLive((l) => ({
            ...l,
            firstEventAt: l.firstEventAt ?? now,
            trace: [
              ...(l.trace ?? []),
              ev.textAt === undefined ? { ...ev, textAt: l.text.length } : ev,
            ],
          }));
      }
    }
    if (!ctrl.signal.aborted) finish({});
  } catch (error) {
    if (ctrl.signal.aborted) return;
    log.warn('side chat failed', error);
    finish({ error: error instanceof Error ? error.message : String(error) });
  }
}

/** 发一个问题（输入栏的文字已含引用块 / 文件附件）；正在回答时排队 */
export async function sendSideChat(
  id: string,
  text: string,
  images?: ReadonlyArray<SideChatImage & { data: string }>,
): Promise<void> {
  const chat = chats.get(id);
  const body = text.trim();
  if (!chat || (!body && !images?.length)) return;
  if (chat.running) {
    if (body) set(id, (s) => ({ ...s, queued: [...s.queued, body] }));
    return;
  }
  const user: ConvMessage = {
    id: newId('u'),
    role: 'user',
    text: body,
    at: Date.now(),
    ...(images?.length
      ? {
          raw: {
            images: images.map(({ mime, thumb, width, height, data }) => ({
              mime,
              thumb,
              width,
              height,
              data,
            })),
          },
        }
      : {}),
  };
  await runTurn(id, user, chat.messages);
}

/** 重新生成：这条助手消息之前的那个问题重新问一次（之后的消息丢掉） */
export async function regenerateSideChat(id: string, assistantId: string): Promise<void> {
  const chat = chats.get(id);
  if (!chat || chat.running) return;
  const index = chat.messages.findIndex((m) => m.id === assistantId);
  if (index < 0) return;
  let u = index - 1;
  while (u >= 0 && chat.messages[u]!.role !== 'user') u -= 1;
  if (u < 0) return;
  await runTurn(id, chat.messages[u]!, chat.messages.slice(0, u));
}

/** 编辑某个问题并重新发送（它之后的消息丢掉；原来带的图片保留） */
export async function editSideChat(id: string, userId: string, text: string): Promise<void> {
  const chat = chats.get(id);
  const body = text.trim();
  if (!chat || chat.running || !body) return;
  const index = chat.messages.findIndex((m) => m.id === userId && m.role === 'user');
  if (index < 0) return;
  const old = chat.messages[index]!;
  await runTurn(
    id,
    { ...old, id: newId('u'), text: body, at: Date.now() },
    chat.messages.slice(0, index),
  );
}

// ---- 弹到独立窗口 / 放回：经宿主内存交接（不落盘）----

/** 交接快照（不含正在跑的一轮、不含原图）。正在回答时不交接。 */
export function exportSideChat(id: string, opts?: { settle?: boolean }): string | null {
  const chat = chats.get(id);
  if (!chat || (chat.running && !opts?.settle)) return null;
  // settle：正在回答也导出，已经写出来的部分按「已停止」收进记录（独立窗口关掉 / 放回时用）
  const partial = chat.running
    ? finishedMessage(chat.running.live, { stopped: true }, chat.model)
    : null;
  const all = partial ? [...chat.messages, partial] : chat.messages;
  const messages = all.map((m) => {
    const images = imagesOf(m);
    return images.length
      ? { ...m, raw: { images: images.map(({ data: _data, ...rest }) => rest) } }
      : m;
  });
  const draft = sideChatDrafts.read(sideChatDraftKey(id));
  return JSON.stringify({
    v: 1,
    chat: { ...chat, messages, running: null, fill: null },
    draft: { text: draft.text, files: draft.files },
  });
}

/** 收下交接快照（已有同一个 id 时覆盖）；返回聊天 id */
export function importSideChat(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as {
      v?: number;
      chat?: Partial<SideChatState>;
      draft?: { text?: string; files?: unknown[] };
    };
    const c = v?.chat;
    if (v?.v !== 1 || !c || typeof c.id !== 'string' || !c.id || !Array.isArray(c.messages))
      return null;
    const chat: SideChatState = {
      id: c.id,
      scope: typeof c.scope === 'string' ? c.scope : '',
      seq: typeof c.seq === 'number' && c.seq > 0 ? c.seq : 1,
      projectId: typeof c.projectId === 'string' ? c.projectId : null,
      messages: c.messages.filter(
        (m): m is ConvMessage =>
          !!m &&
          typeof m.id === 'string' &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.text === 'string',
      ),
      model: typeof c.model === 'string' ? c.model : null,
      ...(typeof c.effort === 'string' ? { effort: c.effort } : {}),
      running: null,
      queued: [],
      fill: null,
    };
    chats.set(chat.id, chat);
    if (typeof v.draft?.text === 'string' || Array.isArray(v.draft?.files))
      sideChatDrafts.write(sideChatDraftKey(chat.id), {
        text: typeof v.draft?.text === 'string' ? v.draft.text : '',
        images: [],
        files: (Array.isArray(v.draft?.files) ? v.draft.files : []) as never[],
      });
    emit();
    return chat.id;
  } catch (error) {
    log.warn('bad side chat handoff', error);
    return null;
  }
}

/** 交出去之后这一侧不再持有（不停正在跑的：交接前已确认没在跑） */
export function forgetSideChat(id: string): void {
  sideChatDrafts.dropPrivate(sideChatDraftKey(id));
  if (chats.delete(id)) emit();
}

/** 单测用：清空所有侧边聊天 */
export function resetSideChats(): void {
  for (const c of aborts.values()) c.abort();
  aborts.clear();
  chats.clear();
  mounted.clear();
  byScopeCache.clear();
  emit();
}
