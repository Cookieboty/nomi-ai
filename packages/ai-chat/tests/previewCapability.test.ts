import { afterEach, describe, expect, it, vi } from 'vitest';

import { PreviewEditSession } from '../src/components/ResourcePreview/previewEdits';
import { resourcePreviewClient, type PreviewResult } from '../src/services/resourcePreviewClient';

vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    save: vi.fn(),
    close: vi.fn(async () => undefined),
    open: vi.fn(),
    renew: vi.fn(),
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const original: PreviewResult = {
  ok: true,
  editable: true,
  url: '/__nomi/preview/token',
  revision: 'a'.repeat(64),
  content: '# Original',
  path: '/work/note.md',
};
const renewed: PreviewResult = {
  ...original,
  url: '/__nomi/preview/fresh',
};

function session() {
  const edit = new PreviewEditSession(original);
  edit.noteOrigin('/work', original.path);
  return edit;
}

describe('expired preview capability', () => {
  it('mints a new grant and saves the draft when the file is unchanged', async () => {
    vi.mocked(resourcePreviewClient.save)
      .mockResolvedValueOnce({ ok: false, code: 'expired' })
      .mockResolvedValueOnce({ ok: true, revision: 'b'.repeat(64) });
    vi.mocked(resourcePreviewClient.renew).mockResolvedValue(renewed);
    const edit = session();
    edit.change('# Draft');
    expect(await edit.flush()).toBe(true);
    expect(resourcePreviewClient.save).toHaveBeenNthCalledWith(
      1,
      original.url,
      original.revision,
      '# Draft',
    );
    expect(resourcePreviewClient.renew).toHaveBeenCalledWith(original.url);
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      renewed.url,
      renewed.revision,
      '# Draft',
    );
    expect(resourcePreviewClient.close).toHaveBeenCalledWith(original.url);
    expect(edit.state).toMatchObject({ text: '# Draft', dirty: false, saving: false });
    expect(resourcePreviewClient.open).not.toHaveBeenCalled();
  });

  it('does not chase a second expired response on the new grant', async () => {
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'expired' });
    vi.mocked(resourcePreviewClient.renew).mockResolvedValue(renewed);
    const edit = session();
    edit.change('# Draft');
    expect(await edit.flush()).toBe(false);
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(2);
    expect(resourcePreviewClient.renew).toHaveBeenCalledTimes(1);
    expect(edit.state).toMatchObject({ dirty: true, error: 'expired', text: '# Draft' });
  });

  it('keeps the draft and does not write when renew reports a conflict or a denial', async () => {
    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'expired' });
    for (const code of ['conflict', 'denied'] as const) {
      vi.mocked(resourcePreviewClient.renew).mockResolvedValue({ ok: false, code });
      const edit = session();
      edit.change('# Draft');
      expect(await edit.flush()).toBe(false);
      expect(resourcePreviewClient.open).not.toHaveBeenCalled();
      expect(edit.state).toMatchObject({ dirty: true, error: code, text: '# Draft' });
    }
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(2);
  });

  it('reopens only after the grant record is gone, and refuses a changed file or path', async () => {
    vi.mocked(resourcePreviewClient.save).mockResolvedValueOnce({ ok: false, code: 'expired' });
    vi.mocked(resourcePreviewClient.renew).mockResolvedValue({ ok: false, code: 'expired' });
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ...renewed,
      content: '# External',
      revision: 'e'.repeat(64),
    });
    const edit = session();
    edit.change('# Draft');
    expect(await edit.flush()).toBe(false);
    expect(resourcePreviewClient.open).toHaveBeenCalledWith('/work', '/work/note.md');
    expect(resourcePreviewClient.close).toHaveBeenCalledWith(renewed.url);
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(1);
    expect(edit.state).toMatchObject({ error: 'conflict', text: '# Draft', dirty: true });

    vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'expired' });
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ...renewed,
      url: '/__nomi/preview/other',
      path: '/work/other.md',
    });
    const replaced = session();
    replaced.change('# Draft');
    expect(await replaced.flush()).toBe(false);
    expect(resourcePreviewClient.close).toHaveBeenCalledWith('/__nomi/preview/other');
    expect(resourcePreviewClient.save).toHaveBeenCalledTimes(2);
    expect(replaced.state.error).toBe('conflict');
  });

  it('saves through a reopened grant when the swept capability and the bytes still match', async () => {
    vi.mocked(resourcePreviewClient.save)
      .mockResolvedValueOnce({ ok: false, code: 'expired' })
      .mockResolvedValueOnce({ ok: true, revision: 'b'.repeat(64) });
    vi.mocked(resourcePreviewClient.renew).mockResolvedValue({ ok: false, code: 'expired' });
    vi.mocked(resourcePreviewClient.open).mockResolvedValue(renewed);
    const edit = session();
    edit.change('# Draft');
    expect(await edit.flush()).toBe(true);
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      renewed.url,
      renewed.revision,
      '# Draft',
    );
    expect(edit.state.dirty).toBe(false);
  });

  it('keeps keystrokes typed during recovery on the new grant', async () => {
    let renew!: (result: PreviewResult) => void;
    vi.mocked(resourcePreviewClient.renew).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          renew = resolve;
        }),
    );
    vi.mocked(resourcePreviewClient.save).mockImplementation(async (url, _revision, content) => {
      if (url === original.url) return { ok: false, code: 'expired' };
      return { ok: true, revision: content === '# Draft' ? 'b'.repeat(64) : 'c'.repeat(64) };
    });
    const edit = session();
    edit.change('# Draft');
    const pending = edit.flush();
    await vi.waitFor(() => expect(resourcePreviewClient.renew).toHaveBeenCalled());
    edit.change('# Draft more');
    renew(renewed);
    expect(await pending).toBe(true);
    expect(resourcePreviewClient.save).toHaveBeenLastCalledWith(
      renewed.url,
      'b'.repeat(64),
      '# Draft more',
    );
    expect(edit.state).toMatchObject({ text: '# Draft more', dirty: false, error: undefined });
  });

  it('discard drops the draft so a later flush can leave, and does not interrupt a save', async () => {
    let finish!: (result: { ok: boolean; revision: string }) => void;
    vi.mocked(resourcePreviewClient.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const edit = session();
    edit.change('# Draft');
    const pending = edit.flush();
    edit.discardDraft();
    expect(edit.state).toMatchObject({ text: '# Draft', dirty: true, saving: true });
    finish({ ok: true, revision: 'b'.repeat(64) });
    expect(await pending).toBe(true);

    vi.mocked(resourcePreviewClient.save).mockClear();
    edit.change('# Again');
    edit.discardDraft();
    expect(edit.state).toMatchObject({ text: '# Draft', dirty: false, error: undefined });
    expect(await edit.flush()).toBe(true);
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
  });
});
