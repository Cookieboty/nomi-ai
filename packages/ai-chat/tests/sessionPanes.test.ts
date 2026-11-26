// @vitest-environment happy-dom
/** 会话面板的纯函数：加面板、向右打开、替换焦点面板、禁止重复绑定、关闭后回单面板、按 sessionKey 查找。 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  persistPaneSplit,
  readPaneSplit,
  readPaneRatio,
  PANE_RATIO_KEY,
  PANE_SPLIT_KEY,
  persistPaneRatio,
} from '../src/services/sessionPanePrefs';
import {
  clampPaneRatio,
  closePane,
  collapseSplit,
  dropSession,
  splitFromFocused,
  focusPane,
  focusedPane,
  nomiSessionKey,
  openSessionInFocus,
  openSessionToSide,
  PANE_RATIO_DEFAULT,
  paneForSession,
  parseSessionKey,
  sessionIdOf,
  setPaneSession,
  singlePaneFor,
  type SessionPanesState,
} from '../src/utils/sessionPanes';

const A = 'nomi:a'; // 项目 p1
const B = 'nomi:b'; // 项目 p2（另一个工程）
const C = 'nomi:c';

const single = (key: string | null = A): SessionPanesState => ({
  panes: [{ id: 'pane-a', sessionKey: key }],
  focusedPaneId: 'pane-a',
});
const split = (left = A, right = B, focus = 'pane-a'): SessionPanesState => ({
  panes: [
    { id: 'pane-a', sessionKey: left },
    { id: 'pane-b', sessionKey: right },
  ],
  focusedPaneId: focus,
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('会话面板：键', () => {
  it('解析 nomi / cli / tab 会话键', () => {
    expect(parseSessionKey('nomi:x1')).toEqual({ kind: 'nomi', id: 'x1' });
    expect(parseSessionKey('cli:claude:s1')).toEqual({
      kind: 'cli',
      backend: 'claude',
      sessionId: 's1',
    });
    expect(parseSessionKey('tab:t1')).toEqual({ kind: 'tab', id: 't1' });
    expect(parseSessionKey(null)).toBeNull();
    expect(parseSessionKey('whatever')).toBeNull();
    expect(sessionIdOf('nomi:x1')).toBe('x1');
    expect(sessionIdOf('cli:codex:s1')).toBe('s1');
    // tab:<id> 是临时键：不是会话 id
    expect(sessionIdOf('tab:t1')).toBeUndefined();
    expect(nomiSessionKey(undefined)).toBeNull();
    expect(nomiSessionKey('x1')).toBe('nomi:x1');
  });
});

describe('会话面板：向右打开', () => {
  it('单面板时在右面板打开另一个会话，左面板不动，焦点到右边', () => {
    const next = openSessionToSide(single(A), B);
    expect(next.panes.map((p) => p.sessionKey)).toEqual([A, B]);
    expect(focusedPane(next).sessionKey).toBe(B);
  });

  it('已拆分时右面板换成要打开的会话，左面板保持原会话', () => {
    const next = openSessionToSide(split(A, B, 'pane-a'), C);
    expect(next.panes.map((p) => p.sessionKey)).toEqual([A, C]);
    expect(next.focusedPaneId).toBe('pane-b');
  });

  it('要打开的会话已经在左边：左右交换，仍然一左一右且不重复', () => {
    const next = openSessionToSide(split(A, B, 'pane-b'), A);
    // 面板 id 跟位置：左格子换成 B、右格子换成 A
    expect(next.panes.map((p) => p.id)).toEqual(['pane-a', 'pane-b']);
    expect(next.panes.map((p) => p.sessionKey)).toEqual([B, A]);
    // 焦点跟着会话：A 原来在左边（焦点），交换后仍聚焦显示 A 的那一边（现在在右）
    expect(focusedPane(next).sessionKey).toBe(A);
    expect(next.focusedPaneId).toBe('pane-b');
    expect(new Set(next.panes.map((p) => p.sessionKey)).size).toBe(2);
  });

  it('要打开的会话已经是右面板：只聚焦', () => {
    const next = openSessionToSide(split(A, B, 'pane-a'), B);
    expect(next.panes.map((p) => p.sessionKey)).toEqual([A, B]);
    expect(next.focusedPaneId).toBe('pane-b');
  });

  it('最多两个面板', () => {
    const next = openSessionToSide(split(A, B), C);
    expect(next.panes).toHaveLength(2);
  });

  it('拆分按钮：单面板时在右边开一个空面板（不复制同一会话），已拆分时只移动焦点', () => {
    const next = splitFromFocused(single(A));
    // 同一会话不能同时出现在两个面板里
    expect(next.panes.map((p) => p.sessionKey)).toEqual([A, null]);
    expect(focusedPane(next).id).toBe('pane-b');
    expect(splitFromFocused(split(A, B, 'pane-a')).focusedPaneId).toBe('pane-b');
  });
});

describe('会话面板：侧栏单击 / 替换焦点面板', () => {
  it('只改焦点面板，另一个面板保持原会话', () => {
    const next = openSessionInFocus(split(A, B, 'pane-a'), C);
    expect(next.panes.map((p) => p.sessionKey)).toEqual([C, B]);
    expect(next.focusedPaneId).toBe('pane-a');
  });

  it('点的是已经开在另一个面板里的会话：聚焦那个面板，不抢它的会话', () => {
    const next = openSessionInFocus(split(A, B, 'pane-a'), B);
    expect(next.panes.map((p) => p.sessionKey)).toEqual([A, B]);
    expect(next.focusedPaneId).toBe('pane-b');
  });

  it('单面板时换会话', () => {
    expect(openSessionInFocus(single(A), C).panes[0]!.sessionKey).toBe(C);
  });

  it('同一会话不会同时出现在两个面板', () => {
    const st = split(A, B, 'pane-a');
    const next = setPaneSession(st, 'pane-b', A);
    expect(focusedPane(next).id).toBe('pane-a');
    expect(next.panes.map((p) => p.sessionKey)).toEqual([A, B]);
  });

  it('焦点给另一个面板（点面板空白处）', () => {
    const next = focusPane(split(A, B, 'pane-a'), 'pane-b');
    expect(next.focusedPaneId).toBe('pane-b');
    expect(focusPane(next, 'missing')).toBe(next);
  });

  it('按 sessionKey 查找面板', () => {
    expect(paneForSession(split(A, B), B)?.id).toBe('pane-b');
    expect(paneForSession(split(A, B), C)).toBeUndefined();
    expect(paneForSession(split(A, B), null)).toBeUndefined();
  });
});

describe('会话面板：关闭', () => {
  it('关掉一个面板回到单面板（剩下的铺满）', () => {
    const [left, right] = split(A, B).panes;
    // 剩下的面板放到 pane-a（铺满主对话列），焦点跟着它
    expect(closePane(split(A, B), 'pane-b')).toEqual({ panes: [left], focusedPaneId: 'pane-a' });
    expect(closePane(split(A, B), 'pane-a')).toEqual({
      panes: [{ ...right, id: 'pane-a' }],
      focusedPaneId: 'pane-a',
    });
  });

  it('关焦点面板时焦点给剩下那个；最后一个面板关不掉', () => {
    expect(focusedPane(closePane(split(A, B, 'pane-b'), 'pane-b')).sessionKey).toBe(A);
    expect(closePane(single(A), 'pane-a')).toEqual(single(A));
  });

  it('取消拆分只留焦点面板', () => {
    const next = collapseSplit(split(A, B, 'pane-b'));
    expect(next.panes.map((p) => p.sessionKey)).toEqual([B]);
  });

  it('会话没了：并排时关掉那个面板，单面板时留一个空面板', () => {
    expect(dropSession(split(A, B), A).panes.map((p) => p.sessionKey)).toEqual([B]);
    expect(dropSession(single(A), A)).toEqual(single(null));
    expect(dropSession(split(A, B), C)).toEqual(split(A, B));
  });

  it('冷启动种子：已打开在某个面板里时不动，否则单面板指向它', () => {
    const splitState = split(A, B);
    expect(singlePaneFor(splitState, B)).toBe(splitState);
    expect(singlePaneFor(single(A), B).panes.map((p) => p.sessionKey)).toEqual([B]);
    const kept = singlePaneFor(split(A, B), C);
    expect(kept.panes).toHaveLength(1);
    expect(kept.panes[0]!.sessionKey).toBe(C);
  });
});

describe('会话面板：比例与持久化', () => {
  it('比例夹在 25%~75%', () => {
    expect(clampPaneRatio(0.1)).toBe(0.25);
    expect(clampPaneRatio(0.9)).toBe(0.75);
    expect(clampPaneRatio(0.4)).toBe(0.4);
    expect(readPaneRatio()).toBe(PANE_RATIO_DEFAULT);
    persistPaneRatio(0.62);
    expect(localStorage.getItem(PANE_RATIO_KEY)).toBe('0.62');
    expect(readPaneRatio()).toBe(0.62);
  });

  it('拆分快照：只有两个不同会话才记；回到单面板清掉', () => {
    expect(readPaneSplit()).toBeNull();
    persistPaneSplit(split(A, B).panes);
    expect(readPaneSplit()).toEqual({ left: A, right: B });
    persistPaneSplit(single(B).panes);
    expect(localStorage.getItem(PANE_SPLIT_KEY)).toBeNull();
    expect(readPaneSplit()).toBeNull();
    // 坏数据当没拆分
    localStorage.setItem(PANE_SPLIT_KEY, '{oops');
    expect(readPaneSplit()).toBeNull();
    localStorage.setItem(PANE_SPLIT_KEY, JSON.stringify({ left: A, right: A }));
    expect(readPaneSplit()).toBeNull();
  });
});

describe('会话面板：焦点与当前会话', () => {
  it('Provider 在焦点会话变化时通知 App（同步 currentId），面板顺序变化也通知', async () => {
    const { render, act } = await import('@testing-library/react');
    const React = (await import('react')).default;
    const { SessionPanesProvider, useSessionPanes } =
      await import('../src/contexts/SessionPanesContext');
    const onFocus = vi.fn();
    const onPanes = vi.fn();
    let api: ReturnType<typeof useSessionPanes>;
    const Probe = () => {
      api = useSessionPanes();
      return null;
    };
    render(
      React.createElement(
        SessionPanesProvider,
        { persist: false, initial: single(A), onFocusSession: onFocus, onPanesChange: onPanes },
        React.createElement(Probe),
      ),
    );
    act(() => api!.openToSide(B));
    expect(onPanes).toHaveBeenLastCalledWith([
      { id: 'pane-a', sessionKey: A },
      { id: 'pane-b', sessionKey: B },
    ]);
    expect(onFocus).toHaveBeenLastCalledWith(B, 'pane-b');
    expect(api!.isSplit).toBe(true);
    act(() => api!.focusPane('pane-a'));
    expect(onFocus).toHaveBeenLastCalledWith(A, 'pane-a');
    act(() => api!.closePane('pane-a'));
    expect(api!.panes).toHaveLength(1);
    expect(api!.focusedKey).toBe(B);
  });
});
