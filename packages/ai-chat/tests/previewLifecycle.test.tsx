// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getPreviewEdits,
  releasePreviewEdit,
} from '../src/components/ResourcePreview/previewEdits';
import { openPreviewTab } from '../src/components/ResourcePreview/previewTabs';
import type { PreviewEntry } from '../src/components/ResourcePreview/ResourcePreview';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

import { changeSource, sourceEditable, sourceValue } from './helpers/codeView';

vi.mock('../src/services/api', () => ({ hostAssetUrl: (url: string) => url }));
vi.mock('../src/services/harnessClient', () => ({
  harnessClient: { workspaceList: vi.fn(async () => ({ ok: true, entries: [] })) },
}));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { open: vi.fn(), close: vi.fn(async () => undefined), save: vi.fn() },
}));
// These tests exercise autosave, so warm the lazy module before timing interactions.
beforeAll(async () => {
  await import('../src/components/ResourcePreview/ResourcePreview');
});
let run = 0;
let sequence = 0;
const retained = new Map<string, string>();
beforeEach(() => {
  run++;
  sequence = 0;
});
afterEach(async () => {
  cleanup();
  vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'cleanup' });
  for (const [key, url] of retained) await releasePreviewEdit(key, url);
  retained.clear();
  vi.resetAllMocks();
});
function Probe() {
  const preview = useResourcePreview({ id: `lifecycle-${run}`, cwd: '/work' });
  return (
    <>
      {Array.from({ length: 14 }, (_, i) => (
        <button key={i} onClick={() => preview.value.open(`/work/${i}.txt`, preview.value.scope)}>
          open {i}
        </button>
      ))}
      <input aria-label="conversation composer" />
      {preview.panel}
    </>
  );
}
async function open(index: number, text = `/work/${index}.txt`) {
  fireEvent.click(screen.getByRole('button', { name: `open ${index}` }));
  await screen.findByTestId('resource-preview-source');
  if (!sourceEditable(screen.getByTestId('resource-preview-source'))) {
    fireEvent.click(screen.getByTestId('resource-preview-edit'));
  }
  await waitFor(() =>
    expect(sourceValue(screen.getByTestId('resource-preview-source'))).toBe(text),
  );
  const key = screen.getByRole('tab', { name: `${index}.txt` }).parentElement!.dataset
    .previewTabKey!;
  const url = vi.mocked(resourcePreviewClient.open).mock.settledResults.at(-1)?.value?.url;
  if (url) retained.set(key, url);
  return key;
}
function change(text: string) {
  changeSource(screen.getByTestId('resource-preview-source'), text);
}

describe('preview navigation autosave', () => {
  it.each(['before-write', 'after-write'] as const)(
    'A → B → A keeps saving with a %s reopen snapshot',
    async (timing) => {
      const disk = new Map<string, { content: string; revision: string }>();
      const caps = new Map<string, { path: string; revision: string }>();
      vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => {
        const file = disk.get(path) ?? { content: path, revision: 'r0' };
        disk.set(path, file);
        const url = `/__nomi/preview/${run}-${++sequence}`;
        caps.set(url, { path, revision: file.revision });
        return { ok: true, kind: 'text', editable: true, path, url, ...file };
      });
      vi.mocked(resourcePreviewClient.close).mockImplementation(async (url) => {
        caps.delete(url);
      });
      const commit = (url: string, revision: string, content: string) => {
        const cap = caps.get(url);
        if (!cap) return { ok: false, code: 'expired' };
        if (cap.revision !== revision || disk.get(cap.path)?.revision !== revision)
          return { ok: false, code: 'conflict' };
        cap.revision = `${revision}+`;
        disk.set(cap.path, { content, revision: cap.revision });
        return { ok: true, revision: cap.revision };
      };
      let finish!: () => void;
      vi.mocked(resourcePreviewClient.save)
        .mockImplementationOnce(
          (url, revision, content) =>
            new Promise((resolve) => {
              const result = timing === 'after-write' ? commit(url, revision, content) : undefined;
              finish = () => resolve(result ?? commit(url, revision, content));
            }),
        )
        .mockImplementation(async (...args) => commit(...args));
      render(<Probe />);
      await open(0);
      change('first edit');
      await open(1);
      expect(resourcePreviewClient.save).toHaveBeenCalledTimes(1);
      await open(0, 'first edit');
      await act(async () => finish());
      change('second edit');
      await waitFor(() => expect(disk.get('/work/0.txt')?.content).toBe('second edit'));
      expect(screen.queryByRole('alert')).toBeNull();
      // Preview saving never intercepts or disables the conversation's input.
      expect(
        (screen.getByRole('textbox', { name: 'conversation composer' }) as HTMLInputElement)
          .disabled,
      ).toBe(false);
    },
  );
});

describe('preview tab capacity', () => {
  it('keeps a failed draft visible past 12 tabs and includes it in Escape close guards', async () => {
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => ({
      ok: true,
      kind: 'text',
      editable: true,
      path,
      content: path,
      revision: 'r0',
      url: `/__nomi/preview/${run}-${++sequence}`,
    }));
    vi.mocked(resourcePreviewClient.close).mockResolvedValue(undefined);
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'write' });
    render(<Probe />);
    const key = await open(0);
    change('unsaved draft');
    for (let i = 1; i < 13; i++) await open(i);
    expect(screen.getAllByRole('tab')).toHaveLength(12);
    expect(screen.getByRole('tab', { name: '0.txt' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '1.txt' })).toBeNull();
    expect(getPreviewEdits([key])[0]?.session.state).toMatchObject({
      text: 'unsaved draft',
      dirty: true,
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '0.txt' }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(screen.getByTestId('resource-preview')).toBeTruthy();
    await waitFor(() =>
      expect(sourceValue(screen.getByTestId('resource-preview-source'))).toBe('unsaved draft'),
    );
  });

  it('never evicts an in-flight writer even when later typing returned to the old baseline', async () => {
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_, path) => ({
      ok: true,
      kind: 'text',
      editable: true,
      path,
      content: path,
      revision: 'r0',
      url: `/__nomi/preview/${run}-${++sequence}`,
    }));
    vi.mocked(resourcePreviewClient.close).mockResolvedValue(undefined);
    let finish!: (result: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, revision: 'r2' });
    render(<Probe />);
    const key = await open(0);
    change('first edit');
    const session = getPreviewEdits([key])[0]!.session;
    let pending!: Promise<boolean>;
    act(() => {
      pending = session.flush();
    });
    // Dirty is false relative to the old baseline, but the in-flight write still
    // changes the file and will require another save to restore this newer draft.
    change('/work/0.txt');
    expect(session.state).toMatchObject({ dirty: false, saving: true });
    try {
      for (let i = 1; i < 13; i++) await open(i);
      expect(screen.getAllByRole('tab')).toHaveLength(12);
      expect(screen.getByRole('tab', { name: '0.txt' })).toBeTruthy();
      expect(screen.queryByRole('tab', { name: '1.txt' })).toBeNull();
    } finally {
      await act(async () => {
        finish({ ok: true, revision: 'r1' });
        await pending;
      });
    }
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      retained.get(key),
      'r1',
      '/work/0.txt',
    );
  });

  it('uses a soft limit when every tab is protected, then evicts clean tabs when available', () => {
    const entries = Array.from({ length: 12 }, (_, i): PreviewEntry => ({
      key: `${i}`,
      href: `${i}.md`,
      scope: { id: 'scope' },
    }));
    const next: PreviewEntry = { key: 'next', href: 'next.md', scope: { id: 'scope' } };
    const full = openPreviewTab(
      { entries, activeKey: '11' },
      next,
      new Set(entries.map((e) => e.key)),
    );
    expect(full.entries).toHaveLength(13);
    expect(full.entries.slice(0, 12)).toEqual(entries);
    const clean = openPreviewTab(full, { ...next, key: 'last' }, new Set(['0']));
    expect(clean.entries).toHaveLength(12);
    expect(clean.entries.map((e) => e.key)).toContain('0');
    expect(clean.entries.map((e) => e.key)).not.toContain('1');
    expect(clean.entries.map((e) => e.key)).not.toContain('2');
  });
});
