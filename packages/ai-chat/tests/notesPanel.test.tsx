// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotesPanel } from '../src/components/NotesPanel';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('NotesPanel（知识与记忆 → 笔记）', () => {
  it('列出笔记、搜索、新建并保存', async () => {
    const saved = vi.fn();
    const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
      if (ch === 'ai:desktop:notes-list')
        return [{ id: 'n1', title: 'Groceries', tags: ['home'], updated: 1, snippet: 'milk' }];
      if (ch === 'ai:desktop:notes-save') {
        saved(a[0]);
        return { id: 'n2', title: 'Idea', body: '', tags: [], updated: 2 };
      }
      return true;
    });
    (window as { aiIPC?: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<NotesPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByTestId('notes-list').textContent).toContain('Groceries'));
    expect(r.getByTestId('notes-panel')).toBeTruthy();
    fireEvent.change(r.getByTestId('notes-search'), { target: { value: 'milk' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:desktop:notes-list', 'milk'));
    fireEvent.click(r.getByTestId('note-new'));
    fireEvent.change(r.getByTestId('note-title'), { target: { value: 'Idea' } });
    fireEvent.click(r.getByTestId('note-save'));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    await waitFor(() => expect(r.getByTestId('notes-msg').textContent).toContain('Idea'));
  });
});
