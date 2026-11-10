/**
 * 会话记录详细程度（Transcript view）。
 *
 * 与 Claude Code Desktop 的 Transcript view 对齐：
 * - normal（精简）：两段回复之间的思考和工具调用合成一行摘要，展开是每一步一行；
 * - thinking（显示思考，初始默认）：工具调用照样合成一行，思考合并成一块单独显示；
 * - verbose（详细）：每次工具调用单独一行，参数与输出、思考、子代理都默认展开。
 *
 * 设置分两层：
 * - 全局默认（设置 → 通用 → 外观）；新会话 / 没有单独设置的会话使用它；
 * - 会话级覆盖（会话标题栏的 Transcript view 菜单）；只影响那个会话，优先级高于全局。
 *
 * 这是界面偏好，不进 Go 内核的会话存储；保存在本机 localStorage。
 */

export type TranscriptView = 'normal' | 'thinking' | 'verbose';

export const TRANSCRIPT_VIEWS: readonly TranscriptView[] = ['normal', 'thinking', 'verbose'];

export const DEFAULT_TRANSCRIPT_VIEW: TranscriptView = 'thinking';

const STORAGE_KEY = 'nomi.transcriptView.v1';
/** 只保留最近使用的会话覆盖数，避免长期使用后 localStorage 无限增长 */
const MAX_SESSIONS = 500;

export interface TranscriptViewState {
  /** 全局默认 */
  global: TranscriptView;
  /** 会话级覆盖（sessionKey → view）；没有键 = 跟随全局 */
  sessions: Record<string, TranscriptView>;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function isTranscriptView(v: unknown): v is TranscriptView {
  return v === 'normal' || v === 'thinking' || v === 'verbose';
}

function parse(raw: string | null): TranscriptViewState {
  const fallback: TranscriptViewState = { global: DEFAULT_TRANSCRIPT_VIEW, sessions: {} };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const obj = parsed as { global?: unknown; sessions?: unknown };
    const global = isTranscriptView(obj.global) ? obj.global : DEFAULT_TRANSCRIPT_VIEW;
    const sessions: Record<string, TranscriptView> = {};
    if (obj.sessions && typeof obj.sessions === 'object' && !Array.isArray(obj.sessions)) {
      for (const [key, value] of Object.entries(obj.sessions as Record<string, unknown>)) {
        if (key && isTranscriptView(value)) sessions[key] = value;
      }
    }
    return { global, sessions };
  } catch {
    return fallback;
  }
}

// useSyncExternalStore 的快照必须是同一对象直到存储变化
let cache: { raw: string | null; state: TranscriptViewState } = {
  raw: null,
  state: { global: DEFAULT_TRANSCRIPT_VIEW, sessions: {} },
};

/** localStorage 写不进去（无痕窗口等）时的内存副本：本次运行内仍然生效 */
let memory: TranscriptViewState | null = null;

export function getTranscriptViewState(): TranscriptViewState {
  if (memory) return memory;
  let raw: string | null = null;
  try {
    if (typeof window !== 'undefined' && window.localStorage)
      raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === cache.raw) return cache.state;
  const state = parse(raw);
  cache = { raw, state };
  return state;
}

function writeState(state: TranscriptViewState): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    memory = null;
  } catch {
    /* 无痕窗口等：只在本次内存里生效 */
    memory = state;
  }
  listeners.forEach((fn) => fn());
}

/** 全局默认 */
export function getGlobalTranscriptView(): TranscriptView {
  return getTranscriptViewState().global;
}

export function setGlobalTranscriptView(view: TranscriptView): void {
  if (!isTranscriptView(view)) return;
  const state = getTranscriptViewState();
  if (state.global === view) return;
  writeState({ ...state, global: view });
}

/** 会话级覆盖；没有返回 null（跟随全局） */
export function getSessionTranscriptView(
  sessionKey: string | null | undefined,
): TranscriptView | null {
  if (!sessionKey) return null;
  return getTranscriptViewState().sessions[sessionKey] ?? null;
}

/** 有效值：会话覆盖优先，否则全局默认 */
export function getTranscriptView(sessionKey: string | null | undefined): TranscriptView {
  return getSessionTranscriptView(sessionKey) ?? getGlobalTranscriptView();
}

/** 设置会话级覆盖；只改这个会话，其它会话不受影响 */
export function setTranscriptView(
  sessionKey: string | null | undefined,
  view: TranscriptView,
): void {
  if (!sessionKey || !isTranscriptView(view)) return;
  const state = getTranscriptViewState();
  if (state.sessions[sessionKey] === view) return;
  const sessions = { ...state.sessions, [sessionKey]: view };
  const keys = Object.keys(sessions);
  if (keys.length > MAX_SESSIONS) {
    for (const key of keys.slice(0, keys.length - MAX_SESSIONS)) delete sessions[key];
  }
  writeState({ ...state, sessions });
}

/** 清掉会话级覆盖，重新跟随全局默认 */
export function clearTranscriptView(sessionKey: string | null | undefined): void {
  if (!sessionKey) return;
  const state = getTranscriptViewState();
  if (!(sessionKey in state.sessions)) return;
  const sessions = { ...state.sessions };
  delete sessions[sessionKey];
  writeState({ ...state, sessions });
}

export function subscribeTranscriptView(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** 单测：清掉全局默认与会话覆盖 */
export function resetTranscriptViewsForTest(): void {
  memory = null;
  try {
    if (typeof window !== 'undefined' && window.localStorage)
      window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}
