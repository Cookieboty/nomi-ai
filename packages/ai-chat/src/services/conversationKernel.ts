/**
 * 会话存储的内核端口（契约 `conversations.*`，内核 userData/conversations/，见 docs/features/chat.md）。
 *
 * - `createContractConversationKernel(api)`：对话窗口里用，走契约；
 * - `createMemoryConversationKernel()`：测试 / 浏览器预览用，行为与内核一致（消息原样保存、导入不覆盖已有 id）。
 *
 * 消息与元信息对内核是不透明的 JSON：内核只认会话 id。
 */

import type { AppClient } from '@nomi-ai/ai-sdk-client';
import { ContractError, isContractError } from '@nomi-ai/contract';
import { isValidConversationId } from '@nomi-ai/contract/app';

import type { ChatMessage, ChatSession } from '../types/chat';

export type ConversationMeta = Omit<ChatSession, 'messages'>;

export interface ConversationSnapshot {
  conversations: ConversationMeta[];
  previews: Record<string, string>;
  counts: Record<string, number>;
  current?: string;
  lastNomi?: string;
  migrated: boolean;
}

export interface ConversationsChangedEvent {
  source?: string;
  ids: string[];
  index: boolean;
}

/** 写入方标记：内核放进 `conversations.changed`，本窗口据此忽略自己写的 */
export interface ConversationKernel {
  state(): Promise<ConversationSnapshot>;
  /** bytes：消息的 JSON 大小（缓存预算用；内核给不出时省略） */
  messages(id: string, limit?: number): Promise<{ messages: ChatMessage[]; bytes?: number }>;
  append(input: {
    id: string;
    messages: ChatMessage[];
    meta?: ConversationMeta;
    preview?: string;
    max?: number;
  }): Promise<void>;
  replace(input: {
    id: string;
    messages: ChatMessage[];
    meta?: ConversationMeta;
    preview?: string;
  }): Promise<void>;
  put(input: { meta: ConversationMeta; messages?: ChatMessage[]; preview?: string }): Promise<void>;
  remove(id: string): Promise<void>;
  /** undefined = 不变，null = 清空 */
  setPointers(input: { current?: string | null; lastNomi?: string | null }): Promise<void>;
  importConversation(input: {
    meta: ConversationMeta;
    messages: ChatMessage[];
    preview?: string;
    first: boolean;
    final: boolean;
  }): Promise<{ imported: boolean }>;
  markMigrated(count: number): Promise<void>;
  onChanged?(fn: (e: ConversationsChangedEvent) => void): () => void;
  /** 本端口写入时带的标记 */
  readonly source?: string;
}

/**
 * 会话 id 也是内核里的文件名：规则来自契约（与 Go 内核的 convstore.ValidID 一致，含 Windows 保留名）
 */
export { isValidConversationId };

/** 内核说这个会话不在（没建成 / 别处删了 / 索引重建过） */
export function isConversationNotFound(e: unknown): boolean {
  return isContractError(e, 'CONVERSATION_NOT_FOUND');
}

/**
 * 重试也不会成功的写入错误（入参被契约 / 内核拒收、过程不存在、没权限）；其余（连接断了、内核 IO 出错）
 * 当作暂时的，退避重试
 */
export function isPermanentWriteError(e: unknown): boolean {
  if (!isContractError(e)) return false;
  return ['BAD_INPUT', 'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN', 'VERSION_MISMATCH'].includes(
    e.code,
  );
}

export function newSourceId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

type ConversationsApi = Pick<AppClient, 'conversations' | 'on'>;

export function createContractConversationKernel(
  api: ConversationsApi,
  source: string = newSourceId(),
): ConversationKernel {
  const c = api.conversations;
  return {
    source,
    async state() {
      const s = await c.state();
      return {
        conversations: s.conversations as unknown as ConversationMeta[],
        previews: s.previews,
        counts: s.counts,
        ...(s.current ? { current: s.current } : {}),
        ...(s.lastNomi ? { lastNomi: s.lastNomi } : {}),
        migrated: s.migrated,
      };
    },
    async messages(id, limit) {
      const r = await c.messages({ id, ...(limit ? { limit } : {}) });
      return {
        messages: r.messages as unknown as ChatMessage[],
        ...(typeof r.bytes === 'number' ? { bytes: r.bytes } : {}),
      };
    },
    async append(input) {
      await c.append({ source, ...input } as never);
    },
    async replace(input) {
      await c.replace({ source, ...input } as never);
    },
    async put(input) {
      await c.put({ source, ...input } as never);
    },
    async remove(id) {
      await c.delete({ source, id });
    },
    async setPointers(input) {
      await c.setPointers({ source, ...input });
    },
    async importConversation(input) {
      const r = await c.import(input as never);
      return { imported: r.imported };
    },
    async markMigrated(count) {
      await c.markMigrated({ count });
    },
    onChanged(fn) {
      return api.on('conversations.changed', (e) =>
        fn({ ids: e.ids, index: e.index, ...(e.source ? { source: e.source } : {}) }),
      );
    },
  };
}

/** 一条消息 / 元信息按 JSON 存一份（与内核一样：不共享引用，存进去的就是取出来的） */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * 内存里的「内核」：测试与浏览器预览用。语义照内核（convstore）：新建的排在末尾、
 * 导入不覆盖已有 id、final 之前不进索引、删除清掉指针。
 */
export function createMemoryConversationKernel(
  opts: { source?: string } = {},
): ConversationKernel & {
  /** 测试用：内核里的原始数据 */
  readonly data: {
    order: string[];
    metas: Map<string, ConversationMeta>;
    messages: Map<string, ChatMessage[]>;
    previews: Record<string, string>;
    current?: string;
    lastNomi?: string;
    migrated?: number;
  };
  /** 测试用：每次调用的名字 */
  readonly calls: string[];
  /** 测试用：让下一次（或某些）调用失败（true = 暂时的错误；也可以给要抛的错误） */
  failNext?: (name: string) => boolean | Error;
  /** 测试用：模拟别的窗口写了（来源不是本端口） */
  emitExternal(ids: string[], index?: boolean): void;
} {
  const data = {
    order: [] as string[],
    metas: new Map<string, ConversationMeta>(),
    messages: new Map<string, ChatMessage[]>(),
    previews: {} as Record<string, string>,
    current: undefined as string | undefined,
    lastNomi: undefined as string | undefined,
    migrated: undefined as number | undefined,
  };
  const staging = new Map<string, ChatMessage[]>();
  const listeners = new Set<(e: ConversationsChangedEvent) => void>();
  const calls: string[] = [];
  const source = opts.source ?? newSourceId();
  const k = {
    source,
    data,
    calls,
    failNext: undefined as ((name: string) => boolean | Error) | undefined,
    emitExternal: (ids: string[], index = true) => emit(ids, index, 'external'),
  };
  const check = (name: string, id?: string) => {
    calls.push(name);
    const fail = k.failNext?.(name);
    if (fail) throw fail === true ? new Error(`${name} failed`) : fail;
    if (id !== undefined && !isValidConversationId(id))
      throw new ContractError('BAD_INPUT', 'invalid conversation id');
  };
  const emit = (ids: string[], index: boolean, from = source) => {
    for (const fn of listeners) fn({ source: from, ids, index });
  };
  const need = (id: string) => {
    if (!data.metas.has(id))
      throw new ContractError('CONVERSATION_NOT_FOUND', `conversation not found: ${id}`);
  };
  const kernel: ConversationKernel = {
    source,
    async state() {
      check('state');
      const counts: Record<string, number> = {};
      for (const id of data.order) counts[id] = data.messages.get(id)?.length ?? 0;
      const previews: Record<string, string> = {};
      for (const id of data.order) if (id in data.previews) previews[id] = data.previews[id]!;
      return clone({
        conversations: data.order.map((id) => data.metas.get(id)!),
        previews,
        counts,
        ...(data.current ? { current: data.current } : {}),
        ...(data.lastNomi ? { lastNomi: data.lastNomi } : {}),
        migrated: data.migrated !== undefined,
      });
    },
    async messages(id, limit) {
      check('messages', id);
      const list = data.metas.has(id) ? (data.messages.get(id) ?? []) : [];
      const messages = clone(limit && list.length > limit ? list.slice(-limit) : list);
      return { messages, bytes: JSON.stringify(messages).length };
    },
    async append({ id, messages, meta, preview, max }) {
      check('append', id);
      need(id);
      let next = [...(data.messages.get(id) ?? []), ...clone(messages)];
      if (max && next.length > max) next = next.slice(-max);
      data.messages.set(id, next);
      if (meta) data.metas.set(id, clone(meta));
      if (preview !== undefined) data.previews[id] = preview;
      emit([id], !!meta);
    },
    async replace({ id, messages, meta, preview }) {
      check('replace', id);
      need(id);
      data.messages.set(id, clone(messages));
      if (meta) data.metas.set(id, clone(meta));
      if (preview !== undefined) data.previews[id] = preview;
      emit([id], !!meta);
    },
    async put({ meta, messages, preview }) {
      check('put', meta.id);
      if (!data.metas.has(meta.id)) {
        data.order.push(meta.id);
        data.messages.set(meta.id, []);
      }
      data.metas.set(meta.id, clone(meta));
      if (messages) data.messages.set(meta.id, clone(messages));
      if (preview !== undefined) data.previews[meta.id] = preview;
      emit([meta.id], true);
    },
    async remove(id) {
      check('delete', id);
      if (!data.metas.has(id)) return;
      data.metas.delete(id);
      data.messages.delete(id);
      delete data.previews[id];
      data.order = data.order.filter((x) => x !== id);
      if (data.current === id) data.current = undefined;
      if (data.lastNomi === id) data.lastNomi = undefined;
      emit([id], true);
    },
    async setPointers({ current, lastNomi }) {
      check('setPointers');
      if (current !== undefined) data.current = current ?? undefined;
      if (lastNomi !== undefined) data.lastNomi = lastNomi ?? undefined;
      emit([], true);
    },
    async importConversation({ meta, messages, preview, first, final }) {
      check('import', meta.id);
      if (data.metas.has(meta.id)) {
        staging.delete(meta.id);
        return { imported: false };
      }
      const prev = first ? [] : (staging.get(meta.id) ?? []);
      staging.set(meta.id, [...prev, ...clone(messages)]);
      if (!final) return { imported: false };
      data.order.push(meta.id);
      data.metas.set(meta.id, clone(meta));
      data.messages.set(meta.id, staging.get(meta.id)!);
      staging.delete(meta.id);
      if (preview !== undefined) data.previews[meta.id] = preview;
      return { imported: true };
    },
    async markMigrated(count) {
      check('markMigrated');
      data.migrated = count;
      emit([], true, '');
    },
    onChanged(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return Object.assign(k, kernel);
}
