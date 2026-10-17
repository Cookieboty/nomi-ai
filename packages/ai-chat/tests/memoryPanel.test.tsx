// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryPanel } from '../src/components/MemoryPanel';
import { AiChatContextProvider } from '../src/contexts/AiChatContext';
import { ingestConversation, memoryContext } from '../src/services/memClient';

import { NomiConversation } from './nomiRender';

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const ep = {
  id: 'e1',
  conversationId: 'c1',
  title: '杭州搬家',
  summary: '下个月搬去杭州。',
  keywords: ['搬家'],
  createdAt: 1,
  updatedAt: 1,
  messageCount: 4,
  pinned: false,
  edited: false,
};

function mockIpc(extra: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch in extra) return extra[ch];
    switch (ch) {
      case 'ai:mem:state':
        return {
          settings: { enabled: true, autoSummarize: true, recall: true, topK: 3, minMessages: 4 },
          stats: { episodes: 1, facts: 1, vectors: 0 },
          busy: [],
          lastError: '',
          personaChars: 0,
        };
      case 'ai:mem:list':
        return {
          episodes: [ep],
          facts: [
            {
              id: 'f1',
              kind: 'identity',
              text: '用户叫小林',
              source: 'distilled',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        };
      default:
        return true;
    }
  });
  (window as { aiIPC?: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return invoke;
}

describe('memory panel', () => {
  it('lists, edits and deletes episodes and facts', async () => {
    const invoke = mockIpc();
    const r = render(
      <AiChatContextProvider>
        <MemoryPanel isVisible onClose={() => undefined} />
      </AiChatContextProvider>,
    );
    await waitFor(() => expect(r.getAllByTestId('mem-episode')).toHaveLength(1));
    fireEvent.click(r.getByTestId('mem-edit'));
    fireEvent.change(r.getByTestId('mem-edit-summary'), { target: { value: '改了' } });
    fireEvent.click(r.getByTestId('mem-save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:mem:update-episode', 'e1', {
        title: '杭州搬家',
        summary: '改了',
      }),
    );
    fireEvent.click(r.getByTestId('mem-delete'));
    fireEvent.click(r.getByTestId('mem-delete-confirm'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:mem:remove', 'episode', 'e1'));

    fireEvent.click(r.getByRole('tab', { name: '关于我' }));
    await waitFor(() => expect(r.getAllByTestId('mem-fact')).toHaveLength(1));
    fireEvent.change(r.getByTestId('mem-new-fact'), { target: { value: '我对花生过敏' } });
    fireEvent.keyDown(r.getByTestId('mem-new-fact'), { key: 'Enter' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:mem:upsert-fact', {
        text: '我对花生过敏',
        kind: 'note',
      }),
    );
    fireEvent.click(r.getByTestId('mem-fact-delete'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:mem:remove', 'fact', 'f1'));
  });

  it('saves persona with Ctrl+S', async () => {
    const invoke = mockIpc({ 'ai:mem:persona': '' });
    const r = render(
      <AiChatContextProvider>
        <MemoryPanel isVisible onClose={() => undefined} />
      </AiChatContextProvider>,
    );
    await waitFor(() => r.getByRole('tab', { name: '用户档案' }));
    fireEvent.click(r.getByRole('tab', { name: '用户档案' }));
    const ta = await waitFor(() => r.getByTestId('mem-persona-input'));
    fireEvent.change(ta, { target: { value: '叫我小林' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:mem:set-persona', '叫我小林'));
  });

  it('context / ingest helpers degrade silently', async () => {
    expect(await memoryContext('x')).toEqual({ text: '', used: [] });
    const invoke = mockIpc({ 'ai:mem:context': { __error: { code: 'x', message: 'boom' } } });
    expect(await memoryContext('x')).toEqual({ text: '', used: [] });
    ingestConversation('c1', [{ role: 'user', content: 'a' }]);
    expect(invoke).not.toHaveBeenCalledWith(
      'ai:mem:ingest',
      expect.anything(),
      expect.anything(),
      false,
    );
    ingestConversation('c1', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(invoke).toHaveBeenCalledWith('ai:mem:ingest', 'c1', expect.any(Array), false);
  });

  it('shows recalled memory tag on assistant bubble', () => {
    const r = render(
      <NomiConversation
        messages={[
          {
            id: 'a',
            role: 'assistant',
            content: 'hi',
            timestamp: 0,
            memories: [{ id: 'e1', kind: 'episode', title: '杭州搬家' }],
          },
        ]}
      />,
    );
    expect(r.getByTestId('memory-tag').textContent).toContain('1 条记忆');
  });
});
