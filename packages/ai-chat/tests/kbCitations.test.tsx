// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { splitCitations } from '../src/components/Conversation/Citations';
import { shortPath } from '../src/services/kbClient';
import type { ChatMessage } from '../src/types/chat';

import { NomiConversation } from './nomiRender';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const src = (n: number, path: string, page?: number) => ({
  n,
  docId: `d${n}`,
  chunkId: `d${n}:0`,
  path,
  title: path.split(/[\\/]/).pop()!,
  page,
  snippet: `snippet ${n}`,
});

describe('knowledge citations', () => {
  it('splits only valid citation numbers', () => {
    expect(splitCitations('a [1] b [3][2]', new Set([1, 2]))).toEqual(['a ', 1, ' b [3]', 2]);
  });

  it('shortens Windows and POSIX paths', () => {
    expect(shortPath('C:\\Users\\me\\Docs\\a.pdf')).toBe('…/Docs/a.pdf');
    expect(shortPath('/home/me/a.md')).toBe('…/me/a.md');
    expect(shortPath('note:n123456')).toBe('笔记');
  });

  it('renders clickable citations and opens a source through IPC', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    (window as { aiIPC?: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const m: ChatMessage = {
      id: 'a',
      role: 'assistant',
      content: '报销需要在 30 天内提交 [1]，超过 5000 需审批 [2]。',
      timestamp: 0,
      kb: true,
      sources: [src(1, 'C:\\Docs\\报销.docx'), src(2, '/srv/policy.pdf', 3)],
    };
    const { getAllByTestId, getByTestId, getByText } = render(<NomiConversation messages={[m]} />);
    expect(getAllByTestId('kb-cite')).toHaveLength(2);
    expect(getAllByTestId('kb-source-chip')).toHaveLength(2);
    expect(getByText('第 3 页')).toBeTruthy();
    fireEvent.click(getAllByTestId('kb-cite')[1]);
    expect(getByTestId('kb-source-preview')).toBeTruthy();
    expect(getByText('snippet 2')).toBeTruthy();
    fireEvent.click(getByTestId('kb-open-file'));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:kb:open', 'd2', 'open'));
  });
});
