import { resourcePreviewClient } from '../../services/resourcePreviewClient';
/**
 * Diff 标签里「编辑」的草稿与视图状态，按标签 key 存在组件之外：
 * 切到别的标签时 FileReview 会卸载，切回来从这里恢复；只在保存成功、丢弃本轮改动或关闭标签时清掉。
 * 标签上限淘汰与关闭标签时用 dirtyReviewDrafts 判断有没有没保存的草稿。
 */
export type ReviewMode = 'diff' | 'file';

export interface FileViewState {
  scrollTop: number;
  selStart: number;
  selEnd: number;
  draft?: string;
  dirty?: boolean;
  /** Baseline and read origin survive remounts together with the draft. */
  baseline?: string;
  root?: string;
  path?: string;
  saving?: boolean;
  /** Successful writes invalidate disk reads started before they completed. */
  savedVersion?: number;
}

export interface ReviewDraftStore {
  /** 文件 key → 滚动 / 选区 / 草稿 */
  views: Map<string, FileViewState>;
  /** 上次停在 Diff 还是编辑 */
  mode?: ReviewMode;
  listeners?: Set<() => void>;
}

const stores = new Map<string, ReviewDraftStore>();

export function reviewDraftStore(key: string): ReviewDraftStore {
  let store = stores.get(key);
  if (!store) {
    store = { views: new Map() };
    stores.set(key, store);
  }
  return store;
}

export function rememberReviewMode(key: string, mode: ReviewMode): void {
  reviewDraftStore(key).mode = mode;
}

/** 这些标签里有没保存草稿的那几个 */
export function dirtyReviewDrafts(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const store = stores.get(key);
    return !!store && [...store.views.values()].some((v) => v.dirty || v.saving);
  });
}

export function dropReviewDrafts(keys: readonly string[]): void {
  for (const key of keys) stores.delete(key);
}

/** Manual saves only: compare the original baseline, then let the kernel compare
 * and save its revision atomically. Never fall back to an unconditional write. */
export async function saveReviewDraft(
  store: ReviewDraftStore,
  state: FileViewState,
): Promise<string | undefined> {
  if (state.saving) return 'saving';
  if (state.baseline === undefined || !state.root || !state.path) return 'denied';
  const content = state.draft ?? state.baseline;
  state.saving = true;
  store.listeners?.forEach((notify) => notify());
  let url: string | undefined;
  try {
    const opened = await resourcePreviewClient.open(state.root, state.path, false, true);
    url = opened.url;
    if (!opened.ok || !opened.editable || opened.truncated || !url || !opened.revision)
      return opened.code ?? 'denied';
    if ((opened.content ?? '') !== state.baseline) return 'conflict';
    const saved = await resourcePreviewClient.save(url, opened.revision, content);
    if (!saved.ok || !saved.revision) return saved.code ?? 'write';
    state.baseline = content;
    state.savedVersion = (state.savedVersion ?? 0) + 1;
    state.dirty = state.draft !== content;
    return undefined;
  } catch {
    return 'write';
  } finally {
    state.saving = false;
    store.listeners?.forEach((notify) => notify());
    if (url) void resourcePreviewClient.close(url).catch(() => undefined);
  }
}
