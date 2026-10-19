// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';

let isLoading = true;
vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));
vi.mock('../src/services/kbClient', async (orig) => ({
  ...(await orig<typeof import('../src/services/kbClient')>()),
  kbClient: { available: () => true },
}));

beforeEach(() => {
  isLoading = true;
  localStorage.clear();
});
afterEach(cleanup);

const typeAndEnter = (text: string) => {
  const ta = document.querySelector('textarea')!;
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: 'Enter' });
};

describe('忙碌时排队的消息保留知识库意图（#37）', () => {
  it('知识库问答开启：排队的消息带 kb 标记', async () => {
    localStorage.setItem('cd.chat.kbMode', '1');
    const onQueue = vi.fn();
    render(<MessageInput queue={{ onQueue }} />);
    await act(async () => typeAndEnter('Q2'));
    await waitFor(() => expect(onQueue).toHaveBeenCalledTimes(1));
    expect(onQueue).toHaveBeenCalledWith('Q2', { kb: true });
  });

  it('普通模式：排队的消息没有 kb 标记（对照）', async () => {
    const onQueue = vi.fn();
    render(<MessageInput queue={{ onQueue }} />);
    await act(async () => typeAndEnter('Q2'));
    await waitFor(() => expect(onQueue).toHaveBeenCalledTimes(1));
    expect(onQueue).toHaveBeenCalledWith('Q2');
  });
});
