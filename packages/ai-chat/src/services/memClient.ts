import { createLogger, t as tr } from '@nomi-ai/ui';
/**
 * 长期记忆客户端：`ai:mem:*` IPC（经 preload 的 window.aiIPC）。数据只在主进程 userData/memory。
 */

const log = createLogger('memory');
export type FactKind = 'identity' | 'preference' | 'goal' | 'dislike' | 'habit' | 'note';

export const FACT_KIND_LABEL: Record<FactKind, string> = {
  identity: '身份',
  preference: '偏好',
  goal: '目标',
  dislike: '不喜欢',
  habit: '习惯',
  note: '其它',
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

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}

function bridge(): AiBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
}

export class MemCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new MemCallError('unavailable', tr('长期记忆需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:mem:${method}`, ...args)) as T & {
    __error?: { code: string; message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error)
    throw new MemCallError(r.__error.code, r.__error.message);
  return r;
}

const on = (ch: string, fn: (p: unknown) => void) => bridge()?.on(ch, fn) ?? (() => undefined);

type Turn = { role: string; content: string };

export const memClient = {
  available: () => !!bridge(),
  state: () => call<MemState>('state'),
  list: (filter = '') => call<{ episodes: MemEpisode[]; facts: MemFact[] }>('list', filter),
  setSettings: (p: Partial<MemSettings>) => call<MemSettings>('set-settings', p),
  persona: () => call<string>('persona'),
  setPersona: (t: string) => call<boolean>('set-persona', t),
  openPersona: () => call<boolean>('open-persona'),
  ingest: (conversationId: string, msgs: Turn[], force = false) =>
    call<{ episode?: MemEpisode; skipped?: string }>('ingest', conversationId, msgs, force),
  context: (q: string) => call<{ text: string; used: MemUsed[] }>('context', q),
  updateEpisode: (id: string, p: Partial<MemEpisode>) => call<MemEpisode>('update-episode', id, p),
  upsertFact: (p: Partial<MemFact>) => call<MemFact>('upsert-fact', p),
  remove: (kind: 'episode' | 'fact', id: string) => call<boolean>('remove', kind, id),
  clear: () => call<boolean>('clear'),
  backfill: () => call<number>('backfill'),
  profile: () => call<Record<string, unknown> | null>('profile'),
  resetProfile: () => call<boolean>('reset-profile'),
  export: (fmt: 'json' | 'md') => call<{ ok: boolean; path?: string }>('export', fmt),
  onChanged: (fn: () => void) => on('ai:mem:changed', () => fn()),
  onStatus: (fn: (p: { busy: string[] }) => void) =>
    on('ai:mem:status', (p) => fn(p as { busy: string[] })),
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
