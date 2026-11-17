// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ChatMessage } from '../src/types/chat';

import { NomiConversation } from './nomiRender';

afterEach(cleanup);

const chat = (over: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage =>
  ({
    role: 'user',
    content: 'q',
    timestamp: 1,
    ...over,
  }) as ChatMessage;

const rows = (container: HTMLElement) =>
  container.querySelectorAll('[data-testid="msg-user"],[data-testid="msg-assistant"]');

describe('点击「显示更早」', () => {
  it('极简视图（当前默认）下也能连续点，每次多加载一批', async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      chat({ id: `s${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }),
    );
    const { container, findByTestId } = render(
      <NomiConversation messages={many} transcriptView="minimal" />,
    );
    const btn = await findByTestId('conv-load-earlier');
    const before = rows(container).length;
    fireEvent.click(btn);
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(before));
  });

  it('可以连续点，每次都能多加载一批', async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      chat({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }),
    );
    const { container, findByTestId } = render(<NomiConversation messages={many} />);
    const btn = await findByTestId('conv-load-earlier');
    const before = rows(container).length;
    expect(before).toBeLessThan(200);

    fireEvent.click(btn);
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(before));
    const afterFirst = rows(container).length;

    const btn2 = await findByTestId('conv-load-earlier');
    fireEvent.click(btn2);
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(afterFirst));
  });

  it('窗口起点落在助手消息上时也要出现「显示更早」', async () => {
    const many: ChatMessage[] = [
      chat({ id: 'a0', role: 'assistant', content: '开场' }),
      ...Array.from({ length: 121 }, (_, i) =>
        chat({ id: `n${i}`, role: i % 2 ? 'user' : 'assistant', content: `内容${i}` }),
      ),
    ];
    const { container, findByTestId } = render(<NomiConversation messages={many} />);
    const btn = await findByTestId('conv-load-earlier');
    const before = rows(container).length;
    fireEvent.click(btn);
    await waitFor(() => expect(rows(container).length).toBeGreaterThan(before));
  });
});
