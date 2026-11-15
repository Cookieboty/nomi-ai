/**
 * 标签区整栏的显示 / 隐藏偏好（替代原来的「变更栏」开关）。
 * - auto：有内容标签时显示（升级前的默认行为）
 * - open：始终显示（没有内容标签时出现新标签页）
 * - closed：隐藏整栏，但不清标签状态
 */
export const SIDE_TABS_PANE_KEY = 'nomi.sideTabsPane.v1';

export type SideTabsPanePref = 'auto' | 'open' | 'closed';

export function readSideTabsPanePref(): SideTabsPanePref {
  try {
    const v = localStorage.getItem(SIDE_TABS_PANE_KEY);
    if (v === 'open' || v === 'closed' || v === 'auto') return v;
    // 以前展开过变更栏的用户：第一次改成「显示标签页」
    if (localStorage.getItem('nomi.filesRailOpen') === '1') return 'open';
  } catch {
    /* ignore */
  }
  return 'auto';
}

export function persistSideTabsPanePref(pref: SideTabsPanePref): void {
  try {
    localStorage.setItem(SIDE_TABS_PANE_KEY, pref);
  } catch {
    /* ignore */
  }
}

/** 有内容标签，或用户明确要求打开时显示 */
export function isSideTabsPaneVisible(pref: SideTabsPanePref, hasContent: boolean): boolean {
  if (pref === 'closed') return false;
  if (pref === 'open') return true;
  return hasContent;
}

/** 空标签时的偏好：会话切换保持 open（由调用方补一个新标签页），只有用户关掉最后一个标签才回到 auto。 */
export function panePrefWhenEmpty(
  pref: SideTabsPanePref,
  cause: 'close-last-tab' | 'empty-scope',
): SideTabsPanePref {
  if (pref !== 'open') return pref;
  return cause === 'close-last-tab' ? 'auto' : 'open';
}
