// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  isSideTabsPaneVisible,
  persistSideTabsPanePref,
  readSideTabsPanePref,
  SIDE_TABS_PANE_KEY,
} from '../src/services/sideTabsPanePrefs';
import {
  EMPTY_SIDE_TABS,
  FILES_SIDE_TAB,
  closeSideTab,
  hasSideTabs,
  openBrowserTab,
  openChanges,
  openFileBrowser,
  openNewTab,
  parseBrowserUrl,
  parseSideTabs,
  resolveActive,
  sideTabItems,
  withoutNewTabs,
  writeSideTabsStore,
  readSideTabsStore,
} from '../src/utils/sideTabs';

afterEach(() => {
  localStorage.clear();
});

describe('workspace tabs: files vs changes', () => {
  it('opens changes and open-file as independent, unique tabs', () => {
    let s = openChanges(EMPTY_SIDE_TABS);
    s = openFileBrowser(s);
    expect(s.pages.map((p) => p.kind)).toEqual(['changes', 'open-file']);
    expect(s.active).toBe('open-file');
    const again = openChanges(s);
    expect(again.pages.filter((p) => p.kind === 'changes')).toHaveLength(1);
    expect(again.active).toBe('changes');
    expect(sideTabItems(again, ['readme.md']).map((i) => i.key)).toEqual([
      'changes',
      'open-file',
      'file:readme.md',
    ]);
  });

  it('keeps a file preview tab while the changes tab stays open', () => {
    const s = openFileBrowser(openChanges(EMPTY_SIDE_TABS));
    expect(hasSideTabs(s, true)).toBe(true);
    expect(resolveActive({ ...s, active: FILES_SIDE_TAB }, true)).toBe(FILES_SIDE_TAB);
    const closed = closeSideTab(s, 'open-file');
    expect(closed.pages.map((p) => p.kind)).toEqual(['changes']);
    expect(resolveActive(closed, true)).toBe('changes');
    expect(resolveActive({ ...closed, active: FILES_SIDE_TAB }, true)).toBe(FILES_SIDE_TAB);
  });

  it('replaces the new tab that opened a unique page', () => {
    const s = openNewTab(EMPTY_SIDE_TABS, 'fresh');
    const next = openChanges(s, { replace: 'new-tab:fresh' });
    expect(next.pages.map((p) => p.kind)).toEqual(['changes']);
    expect(next.active).toBe('changes');
  });
});

describe('workspace tabs: new tab and browser', () => {
  it('parses http(s) and dotted hosts, but not bare filenames', () => {
    expect(parseBrowserUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(parseBrowserUrl('example.com')).toBe('https://example.com/');
    expect(parseBrowserUrl('localhost:5173')).toBe('https://localhost:5173/');
    expect(parseBrowserUrl('README.md')).toBeNull();
    expect(parseBrowserUrl('file:///tmp/a')).toBeNull();
  });

  it('opens a browser tab from a URL and reuses the same address', () => {
    let s = openNewTab(EMPTY_SIDE_TABS, 'n1');
    s = openBrowserTab(s, 'https://example.com', { replace: 'new-tab:n1' });
    expect(s.pages).toHaveLength(1);
    expect(s.pages[0]).toMatchObject({ kind: 'browser', url: 'https://example.com/' });
    const again = openBrowserTab(s, 'https://example.com');
    expect(again.pages).toHaveLength(1);
    expect(again.active).toBe(s.active);
  });

  it('does not persist empty new tabs', () => {
    writeSideTabsStore({ s1: openNewTab(EMPTY_SIDE_TABS, 'gone') });
    expect(readSideTabsStore()).toEqual({});
    const kept = openChanges(openNewTab(EMPTY_SIDE_TABS, 'x'), { replace: 'new-tab:x' });
    writeSideTabsStore({ s1: kept });
    expect(readSideTabsStore().s1?.pages.map((p) => p.kind)).toEqual(['changes']);
    expect(withoutNewTabs(openNewTab(kept, 'z')).pages.map((p) => p.kind)).toEqual(['changes']);
  });
});

describe('tab pane show / hide preference', () => {
  it('auto-shows when there is content, closed hides without relying on tab state', () => {
    expect(isSideTabsPaneVisible('auto', false)).toBe(false);
    expect(isSideTabsPaneVisible('auto', true)).toBe(true);
    expect(isSideTabsPaneVisible('open', false)).toBe(true);
    expect(isSideTabsPaneVisible('closed', true)).toBe(false);
  });

  it('persists the preference and migrates a previously open files rail', () => {
    expect(readSideTabsPanePref()).toBe('auto');
    localStorage.setItem('nomi.filesRailOpen', '1');
    expect(readSideTabsPanePref()).toBe('open');
    persistSideTabsPanePref('closed');
    expect(localStorage.getItem(SIDE_TABS_PANE_KEY)).toBe('closed');
    expect(readSideTabsPanePref()).toBe('closed');
  });
});

describe('parseSideTabs', () => {
  it('reads pages from stored state and ignores junk', () => {
    const s = parseSideTabs({
      agents: [],
      pages: [
        { kind: 'changes' },
        { kind: 'browser', id: 'b1', url: 'https://a.test/' },
        { kind: 'nope' },
      ],
      maximized: false,
    });
    expect(s?.pages).toEqual([
      { kind: 'changes' },
      { kind: 'browser', id: 'b1', url: 'https://a.test/' },
    ]);
  });
});
