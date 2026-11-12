import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PreviewEditSession,
  acquirePreviewEdit,
  releasePreviewEdit,
  getPreviewEdits,
  flushPreviewEdits,
} from '../src/components/ResourcePreview/previewEdits';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { save: vi.fn(), close: vi.fn(async () => undefined) },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('manual Diff editor sessions', () => {
  it('retains a detached draft without debounce or an implicit save, then closes it safely', async () => {
    vi.useFakeTimers();
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'saved' });
    const key = 'manual-diff';
    const session = acquirePreviewEdit(key, original, false)!;
    const onSaved = vi.fn();
    session.noteOnSaved(onSaved);
    session.change('unsaved Diff draft');
    await vi.advanceTimersByTimeAsync(1000);
    await releasePreviewEdit(key, original.url);
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    expect(resourcePreviewClient.close).not.toHaveBeenCalled();
    expect(getPreviewEdits([key])[0]?.session).toBe(session);

    expect(await flushPreviewEdits([key])).toBeUndefined();
    expect(resourcePreviewClient.save).toHaveBeenCalledWith(
      original.url,
      original.revision,
      'unsaved Diff draft',
    );
    expect(onSaved).toHaveBeenCalledOnce();
    expect(getPreviewEdits([key])).toEqual([]);
    expect(resourcePreviewClient.close).toHaveBeenCalledWith(original.url);
  });

  it('keeps later typing and the writer alive when a manual save detaches in flight', async () => {
    const key = 'manual-pending';
    let finish!: (result: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, revision: 'second' });
    const session = acquirePreviewEdit(key, original, false)!;
    session.change('first draft');
    const saved = session.flush();
    session.change('newer draft');
    const released = releasePreviewEdit(key, original.url);
    finish({ ok: true, revision: 'first' });
    await Promise.all([saved, released]);
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      original.url,
      'first',
      'newer draft',
    );
    expect(session.state).toMatchObject({ text: 'newer draft', dirty: false });
    expect(getPreviewEdits([key])).toEqual([]);
  });
});
const original = {
  ok: true,
  editable: true,
  url: '/__nomi/preview/token',
  revision: 'a'.repeat(64),
  content: '# Original',
};
describe('Preview autosave serial writer', () => {
  it('debounces typing and uses the kernel revision, not a blind workspaceWrite', async () => {
    vi.useFakeTimers();
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'b'.repeat(64) });
    const session = new PreviewEditSession(original);
    session.change('# First');
    session.change('# Final');
    await vi.advanceTimersByTimeAsync(449);
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resourcePreviewClient.save).toHaveBeenCalledWith(
      original.url,
      original.revision,
      '# Final',
    );
    expect(session.state).toMatchObject({ text: '# Final', dirty: false, saving: false });
  });
  it('serializes later typing while a save is pending; older success does not discard the newer draft', async () => {
    let resolve!: (v: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue({ ok: true, revision: 'c'.repeat(64) });
    const session = new PreviewEditSession(original);
    session.change('# First');
    const pending = session.flush();
    session.change('# Second');
    resolve({ ok: true, revision: 'b'.repeat(64) });
    await pending;
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(2);
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      original.url,
      'b'.repeat(64),
      '# Second',
    );
    expect(session.state.dirty).toBe(false);
  });
  it('retains drafts on failure and conflict, never silently retrying an external modification', async () => {
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'conflict' });
    const session = new PreviewEditSession(original);
    session.change('# Keep my work');
    expect(await session.flush()).toBe(false);
    session.attach({ ...original, content: '# External', revision: 'b'.repeat(64) });
    session.change('# Keep newer work');
    expect(await session.flush()).toBe(false);
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(1);
    expect(session.state).toMatchObject({
      text: '# Keep newer work',
      dirty: true,
      error: 'conflict',
    });
  });
  it('can retry a transport failure and renews its capability without dropping a dirty draft', async () => {
    vi.mocked(resourcePreviewClient.save)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, revision: 'b'.repeat(64) });
    const session = new PreviewEditSession(original);
    session.change('# Draft');
    await session.flush();
    expect(session.state.error).toBe('write');
    session.attach({ ...original, url: '/__nomi/preview/new-token' });
    expect(await session.flush()).toBe(true);
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      '/__nomi/preview/new-token',
      original.revision,
      '# Draft',
    );
  });
});

describe('reopening an autosaving file', () => {
  it.each(['before-write', 'after-write'] as const)(
    'keeps the writer capability and revision together with a %s snapshot',
    async (timing) => {
      let finish!: (result: { ok: boolean; revision: string }) => void;
      const capabilities = new Map([[original.url, original.revision]]);
      vi.mocked(resourcePreviewClient.save)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockImplementation(async (url, revision) => {
          if (capabilities.get(url) !== revision) return { ok: false, code: 'conflict' };
          capabilities.set(url, 'c'.repeat(64));
          return { ok: true, revision: 'c'.repeat(64) };
        });
      const session = new PreviewEditSession(original);
      session.change('# First');
      const pending = session.flush();
      const reopened = {
        ...original,
        url: '/__nomi/preview/reopened',
        ...(timing === 'after-write' ? { content: '# First', revision: 'b'.repeat(64) } : {}),
      };
      capabilities.set(reopened.url, reopened.revision);
      session.attach(reopened);
      // The new draft must also survive a reopen while the first save is in flight.
      session.change('# Second');
      capabilities.set(original.url, 'b'.repeat(64));
      finish({ ok: true, revision: 'b'.repeat(64) });
      expect(await pending).toBe(true);
      expect(session.state).toMatchObject({ text: '# Second', dirty: false, saving: false });
      expect(session.state.error).toBeUndefined();
      expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
        original.url,
        'b'.repeat(64),
        '# Second',
      );
    },
  );

  it('keeps a reopened session and its writer alive when the old view releases', async () => {
    const key = 'reattach-release';
    let finish!: (result: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, revision: 'c'.repeat(64) });
    const session = acquirePreviewEdit(key, original)!;
    session.change('# First');
    const closingOldView = releasePreviewEdit(key, original.url);
    const reopened = { ...original, url: '/__nomi/preview/reopened' };
    expect(acquirePreviewEdit(key, reopened)).toBe(session);
    finish({ ok: true, revision: 'b'.repeat(64) });
    await closingOldView;
    expect(getPreviewEdits([key])[0]?.session).toBe(session);
    expect(resourcePreviewClient.close).not.toHaveBeenCalledWith(original.url);
    session.change('# Second');
    expect(await session.flush()).toBe(true);
    await releasePreviewEdit(key, reopened.url);
    expect(getPreviewEdits([key])).toEqual([]);
    expect(resourcePreviewClient.close).toHaveBeenCalledWith(original.url);
    expect(resourcePreviewClient.close).toHaveBeenCalledWith(reopened.url);
  });

  it('does not close a newly attached session while the old capability close is awaiting IO', async () => {
    const key = 'close-io-race';
    let finishClose!: () => void;
    vi.mocked(resourcePreviewClient.close).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishClose = () => resolve();
        }),
    );
    const old = acquirePreviewEdit(key, original)!;
    const closing = releasePreviewEdit(key, original.url);
    await Promise.resolve();
    const fresh = acquirePreviewEdit(key, { ...original, url: '/__nomi/preview/fresh' })!;
    expect(fresh).not.toBe(old);
    finishClose();
    await closing;
    expect(getPreviewEdits([key])[0]?.session).toBe(fresh);
    await releasePreviewEdit(key, '/__nomi/preview/fresh');
  });

  it('does not treat a genuinely different disk snapshot as our own write', async () => {
    let finish!: (result: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const session = new PreviewEditSession(original);
    session.change('# First');
    const pending = session.flush();
    session.attach({
      ...original,
      url: '/__nomi/preview/external',
      content: '# External',
      revision: 'external',
    });
    session.change('# New draft');
    finish({ ok: true, revision: 'b'.repeat(64) });
    expect(await pending).toBe(false);
    expect(session.state).toMatchObject({
      text: '# New draft',
      dirty: true,
      saving: false,
      error: 'conflict',
    });
    expect(await session.flush()).toBe(false);
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(1);
  });
});
