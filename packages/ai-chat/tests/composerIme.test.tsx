// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { fitTextarea } from '../src/components/MessageInput/useAutoHeight';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

afterEach(cleanup);

describe('composer IME', () => {
  it('does not send or reset the draft while a composition is open, and commits on compositionend', () => {
    const onSend = vi.fn();
    const { getByTestId } = render(<MessageInput onSend={onSend} />);
    const input = getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.compositionStart(input);
    input.value = '你好nihao';
    fireEvent.change(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('你好nihao');
    input.value = '你好你好';
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('你好你好');
  });
});

describe('fitTextarea', () => {
  it('does not collapse the control to 0px while an IME composition is active', () => {
    const el = document.createElement('textarea');
    document.body.append(el);
    el.value = '你好ni';
    el.style.height = '44px';
    el.dataset.composing = '1';
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 80 });
    fitTextarea(el, 44, 240);
    expect(el.style.height).toBe('80px');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 40 });
    fitTextarea(el, 44, 240);
    expect(el.style.height).toBe('80px');
    delete el.dataset.composing;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 90 });
    fitTextarea(el, 44, 240);
    expect(el.style.height).toBe('90px');
    el.remove();
  });
});
