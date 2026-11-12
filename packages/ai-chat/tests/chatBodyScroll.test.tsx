// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatBody } from '../src/app/ChatBody';
import type { AiChatState } from '../src/contexts/AiChatContext';
import type * as AiChatStoreModule from '../src/contexts/aiChatStore';
import type { ConvMessage } from '../src/types/conversation';

const state = vi.hoisted(() => ({
  messages: [
    { id: 'shared-user', role: 'user', content: 'hello', timestamp: 1 },
    { id: 'shared-answer', role: 'assistant', content: 'answer', timestamp: 2 },
  ],
  isLoading: false,
}));
vi.mock('../src/contexts/aiChatStore', async (original) => ({
  ...(await original<typeof AiChatStoreModule>()),
  useAiChatSelector: (selector: (s: AiChatState) => unknown) => selector(state as AiChatState),
  useAiChatActions: () => ({ actions: { resendFrom: vi.fn() }, store: { get: () => state } }),
}));
vi.mock('../src/services/nomiModel', () => ({
  useGatewayState: () => undefined,
  nomiModelLabel: () => '',
}));

const messages: ConvMessage[] = [
  { id: 'shared-user', role: 'user', text: 'hello', at: 1 },
  { id: 'shared-answer', role: 'assistant', text: 'answer', at: 2 },
];
const props = {
  tabs: { isCliTab: false },
  isDev: false,
  cliMessages: [],
  slash: { cards: [], dismissCard: vi.fn() },
  onOpenModels: vi.fn(),
} as unknown as Omit<React.ComponentProps<typeof ChatBody>, 'sessionKey' | 'nomiMessages'>;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('switching conversations scrolls instantly to the bottom', () => {
  it('resets scrolling between forked conversations with identical message IDs', () => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo');
    const view = (sessionKey: string) => (
      <ChatBody {...props} sessionKey={sessionKey} nomiMessages={messages} />
    );
    const r = render(view('nomi:a'));
    const first = r.getByTestId('conv-scroll');
    first.scrollTop = 100;
    fireEvent.scroll(first);
    expect(r.queryByTestId('conv-jump-bottom')).not.toBeNull();
    scrollTo.mockClear();

    r.rerender(view('nomi:b'));
    expect(r.getByTestId('conv-scroll').scrollTop).toBe(1200);
    expect(r.queryByTestId('conv-jump-bottom')).toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'instant' });
    expect(
      scrollTo.mock.calls.every(
        ([options]) => typeof options === 'object' && options.behavior === 'instant',
      ),
    ).toBe(true);

    const second = r.getByTestId('conv-scroll');
    second.scrollTop = 200;
    fireEvent.scroll(second);
    r.rerender(view('nomi:a'));
    expect(r.getByTestId('conv-scroll').scrollTop).toBe(1200);
  });

  it('preserves manual history reading during updates within the same conversation', () => {
    const view = (nomiMessages: ConvMessage[]) => (
      <ChatBody {...props} sessionKey="nomi:a" nomiMessages={nomiMessages} />
    );
    const r = render(view(messages));
    const el = r.getByTestId('conv-scroll');
    el.scrollTop = 100;
    fireEvent.scroll(el);
    r.rerender(view([...messages, { id: 'next-answer', role: 'assistant', text: 'more', at: 3 }]));
    expect(r.getByTestId('conv-scroll')).toBe(el);
    expect(el.scrollTop).toBe(100);
  });
});
