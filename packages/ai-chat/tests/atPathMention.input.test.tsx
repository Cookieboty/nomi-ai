// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

const workspaceList = vi.fn(async () => ({
  ok: true,
  entries: [
    {
      kind: 'dir' as const,
      name: 'src',
      path: 'src',
      children: [{ kind: 'file' as const, name: 'App.tsx', path: 'src/App.tsx' }],
    },
  ],
}));

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/services/harnessClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/harnessClient')>();
  return {
    ...actual,
    harnessClient: {
      ...actual.harnessClient,
      available: () => true,
      workspaceList: (...args: unknown[]) => workspaceList(...(args as [string])),
    },
  };
});

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

import { MessageInput } from '../src/components/MessageInput';

beforeEach(() => {
  installFakeApi();
});

afterEach(() => {
  cleanup();
  resetFakeApi();
  workspaceList.mockClear();
});

function typeAt(ta: HTMLTextAreaElement, value: string) {
  fireEvent.change(ta, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
  ta.selectionStart = value.length;
  ta.selectionEnd = value.length;
  fireEvent.select(ta);
  fireEvent.keyUp(ta, { key: 'p' });
}

describe('MessageInput @ path mention', () => {
  it('loads workspace paths, picks with Enter, inserts @rel path text (no file chips)', async () => {
    const r = render(<MessageInput cwd="/tmp/proj" onSend={vi.fn()} />);
    const ta = r.getByTestId('chat-input') as HTMLTextAreaElement;
    typeAt(ta, '@App');
    await waitFor(() => expect(r.getByTestId('at-path-item')).toBeTruthy());
    expect(r.getByTestId('at-path-menu')).toBeTruthy();
    expect(workspaceList).toHaveBeenCalledWith('/tmp/proj');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toContain('@src/App.tsx');
    expect(r.queryByTestId('attach-row')).toBeNull();
  });

  it('does not open palette when cwd is omitted', async () => {
    const r = render(<MessageInput onSend={vi.fn()} />);
    const ta = r.getByTestId('chat-input') as HTMLTextAreaElement;
    typeAt(ta, '@App');
    await new Promise((x) => setTimeout(x, 50));
    expect(r.queryByTestId('at-path-menu')).toBeNull();
    expect(workspaceList).not.toHaveBeenCalled();
  });
});
