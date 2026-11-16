// @vitest-environment happy-dom
/**
 * 空输入框按 ↑ 找回上一条提问：要在按键时读最新的消息。拆分 MessageInput 后曾在渲染期取快照，
 * 刚发出的那条还没进快照，↑ 找回的是更早的一条。
 */
import type { KeyboardEvent } from 'react';
import { expect, it, vi } from 'vitest';

import { createKeyDownHandler } from '../src/components/MessageInput/keyboardHandlers';

it('ArrowUp on an empty composer recalls the latest user message at key time', () => {
  let messages = [{ role: 'user', content: '更早的一条' }];
  const setMessage = vi.fn();
  const handler = createKeyDownHandler({
    composingRef: { current: false },
    agentOpen: false,
    modelOpen: false,
    slashOpen: false,
    atOpen: false,
    message: '',
    busy: false,
    setMessage,
    newlineCaret: { current: null },
    handleSend: vi.fn(),
    getChatMessages: () => messages,
  } as unknown as Parameters<typeof createKeyDownHandler>[0]);
  // 处理器在渲染期建好之后，才有新消息发出
  messages = [
    ...messages,
    { role: 'assistant', content: '回复' },
    { role: 'user', content: '刚发的' },
  ];
  const e = {
    key: 'ArrowUp',
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  handler(e);
  expect(setMessage).toHaveBeenCalledWith('刚发的');
});
