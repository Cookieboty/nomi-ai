import type { PreviewEntry } from './ResourcePreview';

export type PreviewTabAction = 'close' | 'all' | 'others' | 'left' | 'right';
export interface PreviewTabsState {
  entries: PreviewEntry[];
  activeKey: string;
}

/** Positions are relative to the context-menu target, not the active document. */
export function previewTabCloseKeys(
  entries: readonly PreviewEntry[],
  key: string,
  action: PreviewTabAction,
): string[] {
  const index = entries.findIndex((entry) => entry.key === key);
  if (index < 0) return [];
  return entries
    .filter((entry, i) => {
      switch (action) {
        case 'close':
          return entry.key === key;
        case 'all':
          return true;
        case 'others':
          return entry.key !== key;
        case 'left':
          return i < index;
        case 'right':
          return i > index;
      }
    })
    .map((entry) => entry.key);
}

/** Remove one snapshot atomically; tabs opened while saving must survive the close. */
export function removePreviewTabs(
  state: PreviewTabsState,
  keys: readonly string[],
): PreviewTabsState {
  const closing = new Set(keys);
  const entries = state.entries.filter((entry) => !closing.has(entry.key));
  if (entries.length === state.entries.length) return state;
  if (entries.some((entry) => entry.key === state.activeKey)) return { ...state, entries };
  const index = state.entries.findIndex((entry) => entry.key === state.activeKey);
  const next = state.entries.slice(index + 1).find((entry) => !closing.has(entry.key));
  return { entries, activeKey: next?.key ?? entries[entries.length - 1]?.key ?? '' };
}

/** The limit is soft: only clean tabs can be evicted without a save/close decision.
 * If every older tab has a draft or pending save, keep them all visible/recoverable. */
export function openPreviewTab(
  state: PreviewTabsState,
  entry: PreviewEntry,
  protectedKeys: ReadonlySet<string>,
  limit = 12,
): PreviewTabsState {
  if (state.entries.some((old) => old.key === entry.key)) {
    return {
      activeKey: entry.key,
      entries: entry.navigation
        ? state.entries.map((old) =>
            old.key === entry.key ? { ...old, navigation: entry.navigation } : old,
          )
        : state.entries,
    };
  }
  let excess = state.entries.length + 1 - limit;
  const entries = state.entries.filter((old) => {
    if (excess <= 0 || protectedKeys.has(old.key)) return true;
    excess--;
    return false;
  });
  return { activeKey: entry.key, entries: [...entries, entry] };
}
