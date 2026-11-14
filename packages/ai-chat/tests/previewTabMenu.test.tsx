// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquirePreviewEdit,
  releasePreviewEdit,
  type PreviewEditSession,
} from '../src/components/ResourcePreview/previewEdits';
import {
  previewTabCloseKeys,
  removePreviewTabs,
} from '../src/components/ResourcePreview/previewTabs';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

vi.mock('../src/services/api', () => ({ hostAssetUrl: (url: string) => url }));
vi.mock('../src/services/harnessClient', () => ({
  harnessClient: { workspaceList: vi.fn(async () => ({ ok: true, entries: [] })) },
}));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { open: vi.fn(), close: vi.fn(async () => ({ ok: true })), save: vi.fn() },
}));
// Load the lazy panel before timing UI assertions under the full workspace test load.
beforeAll(async () => {
  await import('../src/components/ResourcePreview/ResourcePreview');
});
let counter = 0;
let editable = false;
const retained: { key: string; session: PreviewEditSession; url: string; baseline: string }[] = [];
beforeEach(() => {
  counter++;
  editable = false;
  vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => ({
    ok: true,
    kind: 'text',
    content: `content ${path}`,
    path,
    ...(editable
      ? { editable: true, url: `/__nomi/preview/${counter}/${path}`, revision: 'initial' }
      : {}),
  }));
  vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'saved' });
});
afterEach(async () => {
  vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'cleanup' });
  cleanup();
  for (const { key, session, url, baseline } of retained.splice(0)) {
    session.change(baseline);
    await releasePreviewEdit(key, url);
  }
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function Probe() {
  const preview = useResourcePreview({ id: `tab-test-${counter}`, cwd: '/work' });
  return (
    <main className={preview.className} data-testid="workspace">
      {['a', 'b', 'c', 'd'].map((name) => (
        <button
          key={name}
          onClick={() => preview.value.open(`/work/${name}.txt`, preview.value.scope)}
        >
          open {name}
        </button>
      ))}
      <textarea aria-label="conversation" />
      {preview.panel}
    </main>
  );
}
async function open(...names: string[]) {
  for (const name of names) {
    fireEvent.click(screen.getByRole('button', { name: `open ${name}` }));
    await waitFor(() =>
      expect(screen.getByTestId('resource-preview-source').textContent).toContain(
        `content /work/${name}.txt`,
      ),
    );
  }
}
function menu(name: string) {
  fireEvent.contextMenu(screen.getByRole('tab', { name: `${name}.txt` }), {
    clientX: 150,
    clientY: 60,
  });
  return screen.getByRole('menu');
}
function tabs() {
  return screen.queryAllByRole('tab').map((el) => el.textContent);
}
function select(action: string) {
  fireEvent.click(screen.getByTestId(`preview-tab-${action}`));
}
function draft(name: string) {
  const tab = screen.getByRole('tab', { name: `${name}.txt` });
  const key = tab.parentElement!.dataset.previewTabKey!;
  const url = `/__nomi/preview/${counter}//work/${name}.txt`;
  const baseline = `content /work/${name}.txt`;
  const session = acquirePreviewEdit(key, {
    ok: true,
    editable: true,
    url,
    revision: 'initial',
    content: baseline,
  })!;
  retained.push({ key, session, url, baseline });
  act(() => session.change(`draft ${name}`));
  return session;
}

describe('preview tab context menu', () => {
  it.each([
    ['close', ['a.txt', 'c.txt'], 'c.txt'],
    ['all', [], undefined],
    ['others', ['b.txt'], 'b.txt'],
    ['left', ['b.txt', 'c.txt'], 'c.txt'],
    ['right', ['a.txt', 'b.txt'], 'b.txt'],
  ])(
    '%s uses the inactive right-clicked tab, and exits when empty',
    async (action, remaining, active) => {
      render(<Probe />);
      await open('a', 'b', 'c');
      const calls = vi.mocked(resourcePreviewClient.open).mock.calls.length;
      menu('b');
      expect(screen.getByRole('tab', { name: 'c.txt' }).getAttribute('aria-selected')).toBe('true');
      expect(resourcePreviewClient.open).toHaveBeenCalledTimes(calls);
      expect(screen.getAllByRole('menuitem')).toHaveLength(5);
      select(action as string);
      expect(tabs()).toEqual(remaining);
      expect(screen.queryByRole('menu')).toBeNull();
      if (active)
        expect(screen.getByRole('tab', { name: active }).getAttribute('aria-selected')).toBe(
          'true',
        );
      else {
        expect(screen.queryByTestId('resource-preview')).toBeNull();
        expect(screen.queryByRole('separator')).toBeNull();
        expect(screen.getByTestId('workspace').className).toBe('');
        expect(screen.getByRole('textbox', { name: 'conversation' })).toBeTruthy();
      }
    },
  );
  it('uses the next surviving neighbor after closing an active tab, or the previous at the end', async () => {
    render(<Probe />);
    await open('a', 'b', 'c');
    fireEvent.click(screen.getByRole('tab', { name: 'b.txt' }));
    await screen.findByTestId('resource-preview-source');
    menu('b');
    select('close');
    expect(screen.getByRole('tab', { name: 'c.txt' }).getAttribute('aria-selected')).toBe('true');
    menu('c');
    select('close');
    expect(screen.getByRole('tab', { name: 'a.txt' }).getAttribute('aria-selected')).toBe('true');
  });
  it.each(['close', 'all'])('single tab still has a menu; %s exits preview', async (action) => {
    render(<Probe />);
    await open('a');
    menu('a');
    for (const disabled of ['others', 'left', 'right'])
      expect((screen.getByTestId(`preview-tab-${disabled}`) as HTMLButtonElement).disabled).toBe(
        true,
      );
    select(action);
    expect(screen.queryByTestId('resource-preview')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
  it('disables unavailable left/right operations at the edges', async () => {
    render(<Probe />);
    await open('a', 'b', 'c');
    menu('a');
    expect((screen.getByTestId('preview-tab-left') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('preview-tab-right') as HTMLButtonElement).disabled).toBe(false);
    menu('c');
    expect((screen.getByTestId('preview-tab-left') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('preview-tab-right') as HTMLButtonElement).disabled).toBe(true);
  });
  it('supports Shift+F10, arrows, Home/End, and Esc restores tab focus without closing preview', async () => {
    render(<Probe />);
    await open('a', 'b');
    const tab = screen.getByRole('tab', { name: 'a.txt' });
    tab.focus();
    fireEvent.keyDown(tab, { key: 'F10', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('preview-tab-close'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('preview-tab-right'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('preview-tab-others'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByTestId('preview-tab-close'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('preview-tab-right'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('resource-preview')).toBeTruthy();
    expect(document.activeElement).toBe(tab);
  });
  it('outside click dismisses without stealing conversation focus; Tab and window Esc only dismiss the menu', async () => {
    render(<Probe />);
    await open('a');
    menu('a');
    const input = screen.getByRole('textbox', { name: 'conversation' });
    fireEvent.pointerDown(input);
    input.focus();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(input);
    menu('a');
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    menu('a');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('resource-preview')).toBeTruthy();
  });
  it('places the menu outside the clipped preview and clamps it to the viewport', async () => {
    render(<Probe />);
    await open('a');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 210,
      height: 180,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 180,
      right: 210,
      toJSON: () => ({}),
    });
    fireEvent.contextMenu(screen.getByRole('tab'), {
      clientX: window.innerWidth,
      clientY: window.innerHeight,
    });
    const popup = screen.getByRole('menu');
    expect(popup.parentElement).toBe(document.body);
    expect(within(screen.getByTestId('resource-preview')).queryByRole('menu')).toBeNull();
    expect(popup.style.left).toBe(`${window.innerWidth - 214}px`);
    expect(popup.style.top).toBe(`${window.innerHeight - 184}px`);
    fireEvent.resize(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('saves before removing tabs and does not close a new tab opened while save is pending', async () => {
    editable = true;
    render(<Probe />);
    await open('a');
    draft('a');
    let resolve!: (result: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    menu('a');
    select('all');
    expect(tabs()).toEqual(['a.txt']);
    await open('b');
    await act(async () => {
      resolve({ ok: true, revision: 'saved' });
    });
    await waitFor(() => expect(tabs()).toEqual(['b.txt']));
    expect(screen.getByTestId('resource-preview')).toBeTruthy();
  });
  it('rechecks an earlier saved draft if it changes while another tab is still saving', async () => {
    render(<Probe />);
    await open('a', 'b');
    const a = draft('a');
    draft('b');
    let resolve!: (result: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save).mockImplementation(async (url) => {
      if (url.endsWith('/b.txt'))
        return new Promise((r) => {
          resolve = r;
        });
      return { ok: true, revision: 'saved' };
    });
    menu('b');
    select('all');
    await waitFor(() => expect(a.state.dirty).toBe(false));
    act(() => a.change('newer a'));
    await act(async () => {
      resolve({ ok: true, revision: 'saved' });
    });
    await waitFor(() => expect(screen.queryByTestId('resource-preview')).toBeNull());
    expect(resourcePreviewClient.save).toHaveBeenCalledWith(
      expect.stringContaining('/a.txt'),
      'saved',
      'newer a',
    );
    expect(a.state.dirty).toBe(false);
  });

  it.each(['close', 'all', 'others', 'left', 'right'])(
    '%s cannot discard a conflicting draft in the closing set',
    async (action) => {
      render(<Probe />);
      await open('a', 'b', 'c');
      const name = action === 'left' || action === 'others' ? 'a' : action === 'right' ? 'c' : 'b';
      const session = draft(name);
      vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'conflict' });
      menu('b');
      select(action);
      await waitFor(() => expect(session.state.error).toBe('conflict'));
      expect(tabs()).toEqual(['a.txt', 'b.txt', 'c.txt']);
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: `${name}.txt` }).getAttribute('aria-selected')).toBe(
          'true',
        ),
      );
      expect(session.state.text).toBe(`draft ${name}`);
    },
  );
  it('keeps a failing active draft open when the close icon or toolbar close is used', async () => {
    editable = true;
    render(<Probe />);
    await open('a');
    // Fail writes before drafting so a typist debounce cannot save the draft first.
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'write' });
    const session = draft('a');
    const saves = () => vi.mocked(resourcePreviewClient.save).mock.calls.length;
    // Drain that debounce so close-triggered saves have a stable baseline.
    await act(async () => {
      await session.flush();
    });
    await waitFor(() => {
      expect(session.state.error).toBe('write');
      expect(session.state.saving).toBe(false);
    });
    const closeKeepsDraft = async (action: () => void) => {
      const before = saves();
      action();
      await waitFor(() => {
        expect(session.state.error).toBe('write');
        expect(session.state.saving).toBe(false);
        expect(saves()).toBeGreaterThan(before);
      });
      expect(saves()).toBe(before + 1);
      expect(tabs()).toEqual(['a.txt']);
      expect(screen.getByTestId('resource-preview')).toBeTruthy();
    };
    await closeKeepsDraft(() =>
      fireEvent.click(within(screen.getByRole('tablist')).getByRole('button')),
    );
    await closeKeepsDraft(() => fireEvent.keyDown(window, { key: 'Escape' }));
    await closeKeepsDraft(() =>
      fireEvent.click(
        within(screen.getByTestId('resource-preview-header')).getByRole('button', {
          name: /关闭|Close/,
        }),
      ),
    );
  });
});

describe('atomic preview tab state', () => {
  const entries = ['a', 'b', 'c', 'd'].map((key) => ({
    key,
    href: `/work/${key}.txt`,
    scope: { id: 'test' },
  }));
  it('retains the active tab when removing others and never mutates the original array', () => {
    const state = { entries, activeKey: 'b' };
    const next = removePreviewTabs(state, ['a', 'c']);
    expect(next.entries.map((e) => e.key)).toEqual(['b', 'd']);
    expect(next.activeKey).toBe('b');
    expect(state.entries).toHaveLength(4);
    expect(removePreviewTabs(state, ['missing'])).toBe(state);
  });
  it('uses the next surviving neighbor, then the previous, and clears active identity when empty', () => {
    const state = { entries, activeKey: 'b' };
    expect(removePreviewTabs(state, ['b', 'c']).activeKey).toBe('d');
    expect(removePreviewTabs(state, ['b', 'c', 'd']).activeKey).toBe('a');
    expect(removePreviewTabs(state, ['a', 'b', 'c', 'd'])).toEqual({ entries: [], activeKey: '' });
  });
  it('does nothing for a stale context-menu target', () => {
    expect(previewTabCloseKeys(entries, 'missing', 'all')).toEqual([]);
  });
});
