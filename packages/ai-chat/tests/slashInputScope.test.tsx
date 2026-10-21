// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import type { SlashBridge } from '../src/slash/types';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(cleanup);

function bridge(scope: { current: string }) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const b: SlashBridge = {
    compose: () => [],
    refresh: () => undefined,
    scope: () => scope.current,
    run: async () => {
      await gate;
      return { handled: true };
    },
  };
  return { b, release };
}

const submit = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

describe('MessageInput：异步斜杠命令完成后的输入框', () => {
  it('仍在发起命令的会话：清空输入框', async () => {
    const scope = { current: 'tabA' };
    const { b, release } = bridge(scope);
    const { getByTestId } = render(<MessageInput slash={b} onSend={vi.fn()} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    submit(input, '/diff');
    await act(async () => release());
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('命令执行期间用户切到了别的会话：不清掉那边的输入草稿', async () => {
    const scope = { current: 'tabA' };
    const { b, release } = bridge(scope);
    const { getByTestId } = render(<MessageInput slash={b} onSend={vi.fn()} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    submit(input, '/diff');
    scope.current = 'tabB';
    fireEvent.change(input, { target: { value: 'B 里正在写的草稿' } });
    await act(async () => release());
    await new Promise((r) => setTimeout(r, 20));
    expect(input.value).toBe('B 里正在写的草稿');
  });
});
