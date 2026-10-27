/**
 * 标签状态的结构共享：主进程每次 changed() 都会推送完整的 listTabs()（回合开始 / 结束、状态、未读、
 * 后台子代理……），全是新对象。这里把没变的标签 / 字段换回旧引用，整份没变就返回旧状态，
 * 让 useMemo / React.memo 按引用判断时不被无关的广播打穿。
 */
import type { HarnessTabMeta, HarnessTabsState } from '../services/harnessClient';

/** JSON 形态的值（标签元数据只有原始值、普通对象和数组）的深比较 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k) || !jsonEqual(ra[k], rb[k])) return false;
  }
  return true;
}

/** 新标签与旧标签相同则返回旧对象；否则返回新对象，其中没变的嵌套字段（数组 / 对象）沿用旧引用 */
export function shareTab(prev: HarnessTabMeta | undefined, next: HarnessTabMeta): HarnessTabMeta {
  if (!prev || prev === next) return next;
  if (jsonEqual(prev, next)) return prev;
  let out: HarnessTabMeta | null = null;
  const p = prev as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  for (const k of Object.keys(n)) {
    const nv = n[k];
    const pv = p[k];
    if (nv !== pv && typeof nv === 'object' && nv !== null && jsonEqual(pv, nv)) {
      out ??= { ...next };
      (out as unknown as Record<string, unknown>)[k] = pv;
    }
  }
  return out ?? next;
}

/** 把新推送的标签状态与旧状态做结构共享；完全相同时返回 prev 本身 */
export function shareTabsState(
  prev: HarnessTabsState | null,
  next: HarnessTabsState,
): HarnessTabsState {
  if (!prev || prev === next) return next;
  const byId = new Map(prev.tabs.map((tab) => [tab.id, tab]));
  const tabs = next.tabs.map((tab) => shareTab(byId.get(tab.id), tab));
  const sameTabs = tabs.length === prev.tabs.length && tabs.every((tab, i) => tab === prev.tabs[i]);
  const sharedTabs = sameTabs ? prev.tabs : tabs;
  if (sameTabs) {
    const { tabs: _a, ...restPrev } = prev;
    const { tabs: _b, ...restNext } = next;
    if (jsonEqual(restPrev, restNext)) return prev;
  }
  return { ...next, tabs: sharedTabs };
}
