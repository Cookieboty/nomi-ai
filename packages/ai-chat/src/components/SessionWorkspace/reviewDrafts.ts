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
}

export interface ReviewDraftStore {
  /** 文件 key → 滚动 / 选区 / 草稿 */
  views: Map<string, FileViewState>;
  /** 上次停在 Diff 还是编辑 */
  mode?: ReviewMode;
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
    return !!store && [...store.views.values()].some((v) => v.dirty);
  });
}

export function dropReviewDrafts(keys: readonly string[]): void {
  for (const key of keys) stores.delete(key);
}
