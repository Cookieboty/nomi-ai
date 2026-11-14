import { afterEach, describe, expect, it } from 'vitest';

import {
  activateTab,
  agentKey,
  closeAgent,
  cycleTabKey,
  dropIndex,
  EMPTY_SIDE_TABS,
  FILES_SIDE_TAB,
  fileTabKey,
  isMaximized,
  isSplit,
  MAIN_SIDE_TAB,
  moveTab,
  openAgent,
  parseSideTabs,
  pruneAgents,
  readSideTabsStore,
  resolveActive,
  setSplitRatio,
  sideTabItems,
  toggleMaximized,
  toggleSplit,
  writeSideTabsStore,
  type SideTabsState,
  type SubagentTarget,
} from '../src/utils/sideTabs';

const a: SubagentTarget = { kind: 'harness', tabId: 't1' };
const b: SubagentTarget = { kind: 'nested', callId: 'c1', parentTabId: 'p1' };
const c: SubagentTarget = { kind: 'nomi-task', taskId: 'k1' };
const withAll = (): SideTabsState => [a, b, c].reduce(openAgent, EMPTY_SIDE_TABS);

describe('side tabs: open / focus / close', () => {
  it('opens each agent once and focuses an already-open one', () => {
    let s = withAll();
    expect(s.agents.map(agentKey)).toEqual(['harness:t1', 'nested:c1', 'nomi-task:k1']);
    expect(s.active).toBe('nomi-task:k1');
    s = openAgent(s, a);
    expect(s.agents).toHaveLength(3);
    expect(s.active).toBe('harness:t1');
  });

  it('closing the active tab moves to its right neighbour, then the left one', () => {
    let s = activateTab(withAll(), 'nested:c1');
    s = closeAgent(s, 'nested:c1');
    expect(s.active).toBe('nomi-task:k1');
    s = closeAgent(s, 'nomi-task:k1');
    expect(s.active).toBe('harness:t1');
    // 关掉后台的标签不改当前标签
    s = openAgent(s, c);
    s = closeAgent(s, 'harness:t1');
    expect(s.active).toBe('nomi-task:k1');
  });

  it('falls back to the last agent, then files', () => {
    expect(resolveActive(EMPTY_SIDE_TABS, false)).toBeNull();
    expect(resolveActive(EMPTY_SIDE_TABS, true)).toBe(FILES_SIDE_TAB);
    const s = { ...withAll(), active: 'nested:gone' };
    expect(resolveActive(s, true)).toBe('nomi-task:k1');
    expect(resolveActive(activateTab(s, FILES_SIDE_TAB), true)).toBe(FILES_SIDE_TAB);
    // 文件都关了：退回子任务
    expect(resolveActive(activateTab(s, FILES_SIDE_TAB), false)).toBe('nomi-task:k1');
  });

  it('prunes tabs whose agent is gone', () => {
    const s = pruneAgents(activateTab(withAll(), 'harness:t1'), (t) => t.kind !== 'harness');
    expect(s.agents.map(agentKey)).toEqual(['nested:c1', 'nomi-task:k1']);
    expect(resolveActive(s, false)).toBe('nomi-task:k1');
    const same = withAll();
    expect(pruneAgents(same, () => true)).toBe(same);
  });
});

describe('side tabs: maximize', () => {
  it('puts a non-closable main tab first only while maximized', () => {
    const s = withAll();
    expect(sideTabItems(s, ['f1']).map((i) => i.key)).toEqual([
      'harness:t1',
      'nested:c1',
      'nomi-task:k1',
      fileTabKey('f1'),
    ]);
    const max = toggleMaximized(s, 'nested:c1');
    const items = sideTabItems(max, ['f1']);
    expect(items[0]).toMatchObject({ key: MAIN_SIDE_TAB, kind: 'main', closable: false });
    expect(items.slice(1).every((i) => i.closable)).toBe(true);
    expect(resolveActive(max, true)).toBe('nested:c1');
  });

  it('switches to the main tab and back, and restoring keeps the side tab', () => {
    let s = toggleMaximized(withAll(), 'harness:t1');
    s = activateTab(s, MAIN_SIDE_TAB);
    expect(resolveActive(s, false)).toBe(MAIN_SIDE_TAB);
    s = toggleMaximized(s);
    expect(s.maximized).toBe(false);
    expect(resolveActive(s, false)).toBe('harness:t1');
    // 分栏时没有主会话标签
    expect(activateTab(s, MAIN_SIDE_TAB)).toBe(s);
  });

  it('maximizing from a file tab shows files; closing everything restores split', () => {
    const s = toggleMaximized(EMPTY_SIDE_TABS, FILES_SIDE_TAB);
    expect(isMaximized(s, true)).toBe(true);
    expect(resolveActive(s, true)).toBe(FILES_SIDE_TAB);
    expect(isMaximized(s, false)).toBe(false);
    expect(sideTabItems(s, [])).toEqual([]);
  });
});

describe('side tabs: keyboard cycle', () => {
  it('wraps around in both directions', () => {
    const items = sideTabItems(toggleMaximized(withAll()), ['f1']);
    expect(cycleTabKey(items, MAIN_SIDE_TAB, 1)).toBe('harness:t1');
    expect(cycleTabKey(items, MAIN_SIDE_TAB, -1)).toBe(fileTabKey('f1'));
    expect(cycleTabKey(items, fileTabKey('f1'), 1)).toBe(MAIN_SIDE_TAB);
    expect(cycleTabKey([], null, 1)).toBeNull();
  });
});

describe('side tabs: persistence', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage ??= {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  afterEach(() => localStorage.removeItem('nomi.sideTabs.v1'));

  it('round-trips per conversation and drops empty / unnamed scopes', () => {
    const s = toggleMaximized(withAll(), 'nested:c1');
    writeSideTabsStore({ 'nomi:x': s, '': s, 'nomi:empty': EMPTY_SIDE_TABS });
    expect(readSideTabsStore()).toEqual({ 'nomi:x': s });
  });

  it('ignores malformed data', () => {
    localStorage.setItem('nomi.sideTabs.v1', '{not json');
    expect(readSideTabsStore()).toEqual({});
    expect(
      parseSideTabs({ agents: [{ kind: 'harness' }, a, { kind: 'x' }], active: 3, maximized: 1 }),
    ).toEqual({
      agents: [a],
      active: null,
      maximized: false,
      mainActive: false,
      order: [],
      split: false,
      splitRatio: 0.5,
    });
    expect(
      parseSideTabs({ agents: [a], order: ['x', 3], split: true, splitRatio: 9 }),
    ).toMatchObject({ order: ['x'], split: true, splitRatio: 0.8 });
  });
});

describe('side tabs: reorder', () => {
  const keys = (s: SideTabsState, files: string[] = [], hidden?: Set<string>) =>
    sideTabItems(s, files, hidden).map((i) => i.key);

  it('drags a tab to a new position and keeps the order', () => {
    const s = withAll();
    const items = sideTabItems(s, ['f1']);
    // c 拖到 a 前面
    const moved = moveTab(s, items, agentKey(c), dropIndex(items, agentKey(c), agentKey(a), false));
    expect(keys(moved, ['f1'])).toEqual([agentKey(c), agentKey(a), agentKey(b), fileTabKey('f1')]);
    // 文件拖到最前
    const items2 = sideTabItems(moved, ['f1']);
    const moved2 = moveTab(moved, items2, fileTabKey('f1'), 0);
    expect(keys(moved2, ['f1'])[0]).toBe(fileTabKey('f1'));
    // 新开的标签排在后面
    const d: SubagentTarget = { kind: 'harness', tabId: 't9' };
    expect(keys(openAgent(moved2, d), ['f1']).at(-1)).toBe(agentKey(d));
  });

  it('the main tab stays pinned first while maximized', () => {
    const s = toggleMaximized(withAll(), agentKey(a));
    const items = sideTabItems(s, []);
    expect(items[0]!.key).toBe(MAIN_SIDE_TAB);
    expect(moveTab(s, items, MAIN_SIDE_TAB, 3)).toBe(s);
    // 拖到主会话前面 = 排在第一个子任务的位置
    const moved = moveTab(
      s,
      items,
      agentKey(c),
      dropIndex(items, agentKey(c), MAIN_SIDE_TAB, false),
    );
    expect(keys(moved)).toEqual([MAIN_SIDE_TAB, agentKey(c), agentKey(a), agentKey(b)]);
  });

  it('keyboard: one step left / right, clamped at the ends', () => {
    const s = withAll();
    const items = sideTabItems(s, []);
    expect(keys(moveTab(s, items, agentKey(b), 0))).toEqual([
      agentKey(b),
      agentKey(a),
      agentKey(c),
    ]);
    expect(moveTab(s, items, agentKey(a), -1)).toBe(s);
    expect(keys(moveTab(s, items, agentKey(c), 99))).toEqual(keys(s));
  });

  it('closing a tab drops it from the order; drop on itself is a no-op', () => {
    const s = withAll();
    const items = sideTabItems(s, []);
    const moved = moveTab(s, items, agentKey(c), 0);
    expect(closeAgent(moved, agentKey(c)).order).not.toContain(agentKey(c));
    expect(dropIndex(items, agentKey(b), agentKey(b), true)).toBe(1);
    expect(moveTab(s, items, agentKey(b), dropIndex(items, agentKey(b), agentKey(b), true))).toBe(
      s,
    );
  });

  it('hidden (detached) tabs are left out of the strip but keep their place', () => {
    const s = withAll();
    expect(keys(s, ['f1'], new Set([agentKey(b), fileTabKey('f1')]))).toEqual([
      agentKey(a),
      agentKey(c),
    ]);
    const items = sideTabItems(s, [], new Set([agentKey(b)]));
    const moved = moveTab(s, items, agentKey(c), 0);
    expect(moved.order).toEqual([agentKey(c), agentKey(a)]);
    expect(keys(moved)).toEqual([agentKey(c), agentKey(a), agentKey(b)]);
  });
});

describe('side tabs: split', () => {
  it('split right maximizes, keeps main on the left and the chosen tab on the right', () => {
    const s = toggleSplit(withAll(), agentKey(a));
    expect(s.maximized && s.split).toBe(true);
    expect(isSplit(s, false)).toBe(true);
    expect(resolveActive(s, false)).toBe(agentKey(a));
    // 点主会话不换右边
    expect(resolveActive(activateTab(s, MAIN_SIDE_TAB), false)).toBe(agentKey(a));
    // 双击右边别的标签：只换右边，仍拆分
    const other = toggleMaximized(s, agentKey(b));
    expect(other.split && other.maximized).toBe(true);
    expect(resolveActive(other, false)).toBe(agentKey(b));
  });

  it('unsplit stays maximized; restore exits split; no tabs = no split', () => {
    const s = toggleSplit(withAll(), agentKey(a));
    const un = toggleSplit(s);
    expect(un.split).toBe(false);
    expect(un.maximized).toBe(true);
    const restored = toggleMaximized(s, MAIN_SIDE_TAB);
    expect(restored.maximized || restored.split).toBe(false);
    expect(isSplit({ ...EMPTY_SIDE_TABS, split: true, maximized: true }, false)).toBe(false);
  });

  it('ratio is clamped and persisted', () => {
    const s = toggleSplit(withAll(), agentKey(a));
    expect(setSplitRatio(s, 0.05).splitRatio).toBe(0.2);
    expect(setSplitRatio(s, 0.95).splitRatio).toBe(0.8);
    expect(setSplitRatio(s, Number.NaN)).toBe(s);
    const r = setSplitRatio(s, 0.35);
    writeSideTabsStore({ 'nomi:c': r });
    expect(readSideTabsStore()['nomi:c']).toMatchObject({ split: true, splitRatio: 0.35 });
  });
});
