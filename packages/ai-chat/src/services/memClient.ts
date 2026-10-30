import { createLogger, t as tr } from '@nomi-ai/ui';

import { api, hasTransport } from './api';
import { contractErrorCode } from './hostBackends/knowledge';
/**
 * 长期记忆客户端：契约 `mem.*`（docs/design/core-host-decoupling.md §12 P1b，原 `ai:mem:*`）。数据只在主进程 userData/memory。
 */

const log = createLogger('memory');
export type FactKind = 'identity' | 'preference' | 'goal' | 'dislike' | 'habit' | 'note';

export const FACT_KIND_LABEL: Record<FactKind, string> = {
  identity: 'ui.chat-settings.identity',
  preference: 'ui.chat-settings.preferences',
  goal: 'ui.chat-settings.goals',
  dislike: 'ui.chat-settings.dislikes',
  habit: 'ui.chat-settings.habits',
  note: 'ui.chat-settings.other',
};

export interface MemEpisode {
  id: string;
  conversationId: string;
  title: string;
  summary: string;
  keywords: string[];
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  pinned: boolean;
  edited: boolean;
  vec?: string;
}

export interface MemFact {
  id: string;
  kind: FactKind;
  text: string;
  source: 'distilled' | 'user';
  createdAt: number;
  updatedAt: number;
  vec?: string;
}

export interface MemSettings {
  enabled: boolean;
  autoSummarize: boolean;
  recall: boolean;
  topK: number;
  minMessages: number;
}

export interface MemState {
  settings: MemSettings;
  stats: { episodes: number; facts: number; vectors: number };
  busy: string[];
  lastError: string;
  personaChars: number;
}

export interface MemUsed {
  id: string;
  kind: 'episode' | 'fact';
  title: string;
}

export class MemCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 契约错误码 → 旧码（`MEM_NOT_FOUND` → `not-found`，`UNAVAILABLE` → `unavailable`），调用方照旧判断 */
const LEGACY_CODE: Record<string, string> = {
  UNAVAILABLE: 'unavailable',
  MEM_BAD_SUMMARY: 'bad-summary',
  MEM_SUMMARIZE_FAILED: 'summarize-failed',
  MEM_NOT_FOUND: 'not-found',
  MEM_EMPTY: 'empty',
};

async function call<T>(run: () => Promise<unknown>): Promise<T> {
  if (!hasTransport())
    throw new MemCallError(
      'unavailable',
      tr('ui.chat-settings.long-term-memory-requires-the-desktop-app'),
    );
  try {
    return (await run()) as T;
  } catch (err) {
    const code = contractErrorCode(err);
    if (code !== undefined)
      throw new MemCallError(LEGACY_CODE[code] ?? code, (err as Error).message);
    throw err;
  }
}

const on = (subscribe: () => () => void): (() => void) =>
  hasTransport() ? subscribe() : () => undefined;

type Turn = { role: string; content: string };

export const memClient = {
  available: () => hasTransport(),
  state: () => call<MemState>(() => api.mem.state()),
  list: (filter = '') =>
    call<{ episodes: MemEpisode[]; facts: MemFact[] }>(() => api.mem.list({ filter })),
  setSettings: (p: Partial<MemSettings>) => call<MemSettings>(() => api.mem.setSettings(p)),
  persona: () => call<string>(() => api.mem.persona()),
  setPersona: (t: string) => call<boolean>(() => api.mem.setPersona({ text: t })),
  openPersona: () => call<boolean>(() => api.mem.openPersona()),
  ingest: (conversationId: string, msgs: Turn[], force = false) =>
    call<{ episode?: MemEpisode; skipped?: string }>(() =>
      api.mem.ingest({ conversationId, messages: msgs, force }),
    ),
  context: (q: string) => call<{ text: string; used: MemUsed[] }>(() => api.mem.context({ q })),
  updateEpisode: (id: string, p: Partial<MemEpisode>) =>
    call<MemEpisode>(() => api.mem.updateEpisode({ id, patch: p })),
  upsertFact: (p: Partial<MemFact>) => call<MemFact>(() => api.mem.upsertFact(p)),
  remove: (kind: 'episode' | 'fact', id: string) =>
    call<boolean>(() => api.mem.remove({ kind, id })),
  clear: () => call<boolean>(() => api.mem.clear()),
  backfill: () => call<number>(() => api.mem.backfill()),
  profile: () => call<Record<string, unknown> | null>(() => api.mem.profile()),
  resetProfile: () => call<boolean>(() => api.mem.resetProfile()),
  export: (fmt: 'json' | 'md') =>
    call<{ ok: boolean; path?: string }>(() => api.mem.export({ format: fmt })),
  onChanged: (fn: () => void) => on(() => api.on('mem.changed', () => fn())),
  onStatus: (fn: (p: { busy: string[] }) => void) => on(() => api.on('mem.status', (p) => fn(p))),
};

/** 取召回片段；失败（未开启 / 主进程旧版本）时静默返回空，不影响对话 */
export async function memoryContext(q: string): Promise<{ text: string; used: MemUsed[] }> {
  if (!memClient.available()) return { text: '', used: [] };
  try {
    return await memClient.context(q);
  } catch {
    return { text: '', used: [] };
  }
}

/** 后台摘要一段会话（失败只记日志） */
export function ingestConversation(id: string | undefined, msgs: Turn[]): void {
  if (!id || !memClient.available()) return;
  const turns = msgs.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (turns.length < 2) return;
  void memClient.ingest(id, turns).catch((e) => log.warn('summarize failed', e));
}
