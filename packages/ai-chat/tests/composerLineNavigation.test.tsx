// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';
import { moveTextareaToLineBoundary } from '../src/utils/keyboard';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));
afterEach(cleanup);
const text = '第一行\nsecond line\n末行';
const textarea = () => {
  const el = document.createElement('textarea');
  el.value = text;
  return el;
};

describe('Home/End logical-line navigation', () => {
  it('moves to logical line boundaries, not document boundaries', () => {
    const el = textarea();
    el.setSelectionRange(9, 9);
    moveTextareaToLineBoundary(el, 'Home', false, false);
    expect(el.selectionStart).toBe(4);
    el.setSelectionRange(9, 9);
    moveTextareaToLineBoundary(el, 'End', false, false);
    expect(el.selectionStart).toBe(15);
    moveTextareaToLineBoundary(el, 'Home', false, true);
    expect(el.selectionStart).toBe(0);
    moveTextareaToLineBoundary(el, 'End', false, true);
    expect(el.selectionStart).toBe(text.length);
  });
  it('keeps the anchor while extending and reversing selection', () => {
    const el = textarea();
    el.setSelectionRange(9, 9);
    moveTextareaToLineBoundary(el, 'Home', true, false);
    expect([el.selectionStart, el.selectionEnd, el.selectionDirection]).toEqual([4, 9, 'backward']);
    moveTextareaToLineBoundary(el, 'End', true, false);
    expect([el.selectionStart, el.selectionEnd, el.selectionDirection]).toEqual([9, 15, 'forward']);
    moveTextareaToLineBoundary(el, 'Home', true, true);
    expect([el.selectionStart, el.selectionEnd, el.selectionDirection]).toEqual([0, 9, 'backward']);
  });
  it('handles empty lines, trailing newlines and empty input', () => {
    const el = textarea();
    el.value = 'a\n\n';
    el.setSelectionRange(2, 2);
    moveTextareaToLineBoundary(el, 'End', false, false);
    expect(el.selectionStart).toBe(2);
    el.setSelectionRange(3, 3);
    moveTextareaToLineBoundary(el, 'Home', false, false);
    expect(el.selectionStart).toBe(3);
    el.value = '';
    moveTextareaToLineBoundary(el, 'End', true, false);
    expect(el.selectionEnd).toBe(0);
  });
  it('routes composer keys without sending; leaves IME keys alone', () => {
    const send = vi.fn();
    const r = render(<MessageInput onSend={send} />);
    const el = r.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(el, { target: { value: text } });
    el.setSelectionRange(9, 9);
    fireEvent.keyDown(el, { key: 'Home' });
    expect(el.selectionStart).toBe(4);
    fireEvent.keyDown(el, { key: 'End', ctrlKey: true });
    expect(el.selectionStart).toBe(text.length);
    el.setSelectionRange(9, 9);
    fireEvent.compositionStart(el);
    fireEvent.keyDown(el, { key: 'Home' });
    expect(el.selectionStart).toBe(9);
    fireEvent.compositionEnd(el);
    fireEvent.keyDown(el, { key: 'End', keyCode: 229 });
    expect(el.selectionStart).toBe(9);
    expect(send).not.toHaveBeenCalled();
  });
});
