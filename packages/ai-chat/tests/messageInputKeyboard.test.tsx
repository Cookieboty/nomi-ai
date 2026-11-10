// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageInput } from '../src/components/MessageInput';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function inputWith(value: string, props: React.ComponentProps<typeof MessageInput> = {}) {
  const onSend = vi.fn();
  const { getByTestId } = render(<MessageInput {...props} onSend={onSend} />);
  const input = getByTestId('chat-input') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value } });
  return { input, onSend };
}

describe('composer keyboard', () => {
  it.each(['MacIntel', 'Win32'])(
    'inserts Alt+Enter at the caret on %s without sending',
    (platform) => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
      const { input, onSend } = inputWith('ab中文cd');
      input.setSelectionRange(4, 4);
      fireEvent.keyDown(input, { key: 'Enter', altKey: true });
      expect(input.value).toBe('ab中文\ncd');
      expect(input.selectionStart).toBe(5);
      expect(input.selectionEnd).toBe(5);
      expect(onSend).not.toHaveBeenCalled();
    },
  );
  it('replaces selection with a newline even in slash-command input', () => {
    const { input, onSend } = inputWith('/help');
    input.setSelectionRange(1, 5);
    fireEvent.keyDown(input, { key: 'Enter', altKey: true });
    expect(input.value).toBe('/\n');
    expect(input.selectionStart).toBe(2);
    expect(onSend).not.toHaveBeenCalled();
  });
  it('does not intercept native Shift+Enter in a command palette', () => {
    const { input, onSend } = inputWith('/help');
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });
  it.each([{ key: 'Enter' }, { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true }])(
    'keeps sending with %j',
    (key) => {
      const { input, onSend } = inputWith('hello');
      fireEvent.keyDown(input, key);
      expect(onSend).toHaveBeenCalledWith('hello');
    },
  );
  it('does not queue or send Alt+Enter while an assistant is running', () => {
    const onQueue = vi.fn();
    const { input, onSend } = inputWith('hello', { busyOverride: true, queue: { onQueue } });
    input.setSelectionRange(2, 2);
    fireEvent.keyDown(input, { key: 'Enter', altKey: true });
    expect(input.value).toBe('he\nllo');
    expect(onQueue).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
  it.each([{ ctrlKey: true }, { metaKey: true }])(
    'queues modified Enter with %j instead of inserting a newline',
    (modifier) => {
      const onQueue = vi.fn();
      const { input, onSend } = inputWith('hello', { busyOverride: true, queue: { onQueue } });
      fireEvent.keyDown(input, { key: 'Enter', ...modifier });
      expect(onQueue).toHaveBeenCalledWith('hello', { mode: 'queue' });
      expect(onSend).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    },
  );
  it('moves Home/End to the current line boundaries, not the document boundaries', () => {
    const { input } = inputWith('first\n中文 second\nlast');
    input.setSelectionRange(9, 9);
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.selectionStart).toBe(6);
    fireEvent.keyDown(input, { key: 'End' });
    expect(input.selectionStart).toBe(15);
    fireEvent.keyDown(input, { key: 'Home', ctrlKey: true });
    expect(input.selectionStart).toBe(0);
    fireEvent.keyDown(input, { key: 'End', metaKey: true });
    expect(input.selectionStart).toBe(input.value.length);
  });
  it('keeps the anchor when extending and reversing a selection', () => {
    const { input } = inputWith('first\nsecond\nlast');
    input.setSelectionRange(9, 9);
    fireEvent.keyDown(input, { key: 'Home', shiftKey: true });
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      6,
      9,
      'backward',
    ]);
    fireEvent.keyDown(input, { key: 'End', shiftKey: true });
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      9,
      12,
      'forward',
    ]);
  });
  it('handles empty lines and boundaries', () => {
    const { input } = inputWith('\nsecond\n');
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.selectionStart).toBe(0);
    fireEvent.keyDown(input, { key: 'End' });
    expect(input.selectionStart).toBe(0);
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.selectionStart).toBe(input.value.length);
  });
  it('leaves IME confirmation and navigation alone', () => {
    const { input, onSend } = inputWith('中文');
    input.setSelectionRange(1, 1);
    fireEvent.keyDown(input, { key: 'Enter', altKey: true, keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Home', isComposing: true });
    expect(input.value).toBe('中文');
    expect(input.selectionStart).toBe(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});
