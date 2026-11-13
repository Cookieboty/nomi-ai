import { afterEach, describe, expect, it } from 'vitest';

import {
  activateTab,
  agentKey,
  closeAgent,
  cycleTabKey,
  EMPTY_SIDE_TABS,
  FILES_SIDE_TAB,
  fileTabKey,
  isMaximized,
  MAIN_SIDE_TAB,
  openAgent,
  parseSideTabs,
  pruneAgents,
  readSideTabsStore,
  resolveActive,
  sideTabItems,
  toggleMaximized,
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
    ).toEqual({ agents: [a], active: null, maximized: false, mainActive: false });
  });
});
