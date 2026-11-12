// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FileReview } from '../src/components/SessionWorkspace/FileReview';
import {
  dirtyReviewDrafts,
  dropReviewDrafts,
  reviewDraftStore,
} from '../src/components/SessionWorkspace/reviewDrafts';
import { harnessClient } from '../src/services/harnessClient';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';
vi.mock('../src/services/harnessClient', () => ({
  harnessClient: { workspaceRead: vi.fn(), workspaceWrite: vi.fn() },
}));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: { open: vi.fn(), save: vi.fn(), close: vi.fn() },
}));
const mount = () =>
  render(
    <FileReview
      files={[{ key: 'a', path: 'a.txt' }]}
      activeKey="a"
      cwd="/w"
      draftKey="save-test"
      onActiveKey={() => {}}
      onClose={() => {}}
    />,
  );
const editor = async () => {
  const el = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
  await waitFor(() => expect(el.value).not.toBe(''));
  return el;
};
beforeEach(() => {
  vi.mocked(harnessClient.workspaceRead).mockResolvedValue({ ok: true, content: 'base' });
  vi.mocked(resourcePreviewClient.open).mockResolvedValue({
    ok: true,
    editable: true,
    content: 'base',
    url: 'cap',
    revision: 'r1',
  });
  vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: true, revision: 'r2' });
  vi.mocked(resourcePreviewClient.close).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  dropReviewDrafts(['save-test']);
  vi.resetAllMocks();
});
it('uses a revision capability instead of blind workspaceWrite', async () => {
  mount();
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await waitFor(() =>
    expect(resourcePreviewClient.save).toHaveBeenCalledWith('cap', 'r1', 'draft'),
  );
  expect(harnessClient.workspaceWrite).not.toHaveBeenCalled();
  expect(resourcePreviewClient.open).toHaveBeenCalledWith('/w', 'a.txt', false, true);
});
it('retains the original baseline across remount and rejects an external change', async () => {
  const first = mount();
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  first.unmount();
  vi.mocked(harnessClient.workspaceRead).mockResolvedValue({ ok: true, content: 'external' });
  vi.mocked(resourcePreviewClient.open).mockResolvedValue({
    ok: true,
    editable: true,
    content: 'external',
    url: 'cap',
    revision: 'r2',
  });
  mount();
  expect((await editor()).value).toBe('draft');
  fireEvent.click(screen.getByTestId('preview-save'));
  await screen.findByTestId('preview-error');
  expect(resourcePreviewClient.save).not.toHaveBeenCalled();
  expect(reviewDraftStore('save-test').views.get('a')?.dirty).toBe(true);
});
it('keeps a failed draft and retries via the save button', async () => {
  vi.mocked(resourcePreviewClient.save).mockResolvedValueOnce({ ok: false, code: 'write' });
  mount();
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await screen.findByTestId('preview-error');
  expect(reviewDraftStore('save-test').views.get('a')?.dirty).toBe(true);
  fireEvent.click(screen.getByTestId('preview-save'));
  await waitFor(() => expect(resourcePreviewClient.save).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(reviewDraftStore('save-test').views.get('a')?.dirty).toBe(false));
});
it('does not clear typing made while save is pending', async () => {
  let resolve!: (v: { ok: boolean; revision: string }) => void;
  vi.mocked(resourcePreviewClient.save).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  mount();
  const ta = await editor();
  fireEvent.change(ta, { target: { value: 'first' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await waitFor(() => expect(resourcePreviewClient.save).toHaveBeenCalled());
  fireEvent.change(ta, { target: { value: 'later' } });
  resolve({ ok: true, revision: 'r2' });
  await waitFor(() =>
    expect((screen.getByTestId('preview-save') as HTMLButtonElement).disabled).toBe(false),
  );
  expect(ta.value).toBe('later');
  expect(reviewDraftStore('save-test').views.get('a')?.draft).toBe('later');
  expect(reviewDraftStore('save-test').views.get('a')?.dirty).toBe(true);
});
it('surfaces an atomic save conflict without clearing the draft', async () => {
  vi.mocked(resourcePreviewClient.save).mockResolvedValue({ ok: false, code: 'conflict' });
  mount();
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  const error = await screen.findByTestId('preview-error');
  expect(error.textContent).toBeTruthy();
  expect(reviewDraftStore('save-test').views.get('a')?.draft).toBe('draft');
  expect(reviewDraftStore('save-test').views.get('a')?.dirty).toBe(true);
  await waitFor(() => expect(resourcePreviewClient.close).toHaveBeenCalledWith('cap'));
});
it('does not save a truncated or read-only grant', async () => {
  vi.mocked(resourcePreviewClient.open).mockResolvedValue({
    ok: true,
    editable: true,
    truncated: true,
    content: 'base',
    url: 'cap',
    revision: 'r1',
  });
  mount();
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await screen.findByTestId('preview-error');
  expect(resourcePreviewClient.save).not.toHaveBeenCalled();
  expect(reviewDraftStore('save-test').views.get('a')?.dirty).toBe(true);
});
it('keeps a save response on its original file when the view switches', async () => {
  let resolve!: (v: { ok: boolean; revision: string }) => void;
  vi.mocked(resourcePreviewClient.save).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const props = {
    files: [
      { key: 'a', path: 'a.txt' },
      { key: 'b', path: 'b.txt' },
    ],
    cwd: '/w',
    draftKey: 'save-test',
    onActiveKey: () => {},
    onClose: () => {},
  };
  const view = render(<FileReview {...props} activeKey="a" />);
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await waitFor(() => expect(resourcePreviewClient.save).toHaveBeenCalled());
  vi.mocked(harnessClient.workspaceRead).mockResolvedValue({ ok: true, content: 'second' });
  view.rerender(<FileReview {...props} activeKey="b" />);
  await waitFor(() =>
    expect((screen.getByTestId('preview-editor') as HTMLTextAreaElement).value).toBe('second'),
  );
  resolve({ ok: true, revision: 'r2' });
  await waitFor(() => expect(reviewDraftStore('save-test').views.get('a')?.saving).toBe(false));
  expect((screen.getByTestId('preview-editor') as HTMLTextAreaElement).value).toBe('second');
  expect(reviewDraftStore('save-test').views.get('b')?.baseline).toBe('second');
});
it('retains the pending draft when typing returns to its baseline', async () => {
  let resolve!: (v: { ok: boolean; revision: string }) => void;
  vi.mocked(resourcePreviewClient.save).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  mount();
  const ta = await editor();
  fireEvent.change(ta, { target: { value: 'first' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await waitFor(() => expect(resourcePreviewClient.save).toHaveBeenCalled());
  fireEvent.change(ta, { target: { value: 'base' } });
  expect(dirtyReviewDrafts(['save-test'])).toEqual(['save-test']);
  resolve({ ok: true, revision: 'r2' });
  await waitFor(() => expect(reviewDraftStore('save-test').views.get('a')?.saving).toBe(false));
  expect(reviewDraftStore('save-test').views.get('a')?.dirty).toBe(true);
});
it('updates save state after an editor unmounts and remounts', async () => {
  let resolve!: (v: { ok: boolean; revision: string }) => void;
  vi.mocked(resourcePreviewClient.save).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const first = mount();
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await waitFor(() => expect(resourcePreviewClient.save).toHaveBeenCalled());
  first.unmount();
  mount();
  expect((await editor()).value).toBe('draft');
  expect((screen.getByTestId('preview-save') as HTMLButtonElement).disabled).toBe(true);
  resolve({ ok: true, revision: 'r2' });
  await waitFor(() =>
    expect((screen.getByTestId('preview-save') as HTMLButtonElement).disabled).toBe(false),
  );
  expect((screen.getByTestId('preview-editor') as HTMLTextAreaElement).value).toBe('draft');
});
it('releases the busy UI when save completes after switching to Diff', async () => {
  let resolve!: (v: { ok: boolean; revision: string }) => void;
  vi.mocked(resourcePreviewClient.save).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const diff = {
    file: 'a.txt',
    diff: { added: 1, removed: 0, lines: [{ type: 'add' as const, text: 'base', newNo: 1 }] },
  };
  render(
    <FileReview
      files={[
        {
          key: 'a',
          path: 'a.txt',
          gitDiff: diff,
          change: {
            file: 'a.txt',
            added: 1,
            removed: 0,
            status: 'modified',
            letter: 'M',
            diff,
            messageId: 'm',
          },
        },
      ]}
      activeKey="a"
      cwd="/w"
      draftKey="save-test"
      onActiveKey={() => {}}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByTestId('preview-mode-file'));
  fireEvent.change(await editor(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByTestId('preview-save'));
  await waitFor(() => expect(resourcePreviewClient.save).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
  expect((screen.getByTestId('preview-discard') as HTMLButtonElement).disabled).toBe(true);
  resolve({ ok: true, revision: 'r2' });
  await waitFor(() =>
    expect((screen.getByTestId('preview-discard') as HTMLButtonElement).disabled).toBe(false),
  );
});
