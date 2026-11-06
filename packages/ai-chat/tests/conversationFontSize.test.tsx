// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import { MessageInput } from '../src/components/MessageInput';
import { ConversationFontSizeSettings } from '../src/components/SettingsView/ConversationFontSizeSettings';
import {
  getConversationFontSize,
  setConversationFontSize,
} from '../src/services/conversationFontSize';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

beforeEach(() => {
  localStorage.clear();
  setConversationFontSize(14);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setConversationFontSize(14);
  localStorage.clear();
});

const conversation = (scopeId?: string) => (
  <ConversationView
    scopeId={scopeId}
    phase="idle"
    messages={[
      { id: 'u', role: 'user', text: '用户正文', at: 1 },
      { id: 'a', role: 'assistant', text: '助手正文', at: 2 },
    ]}
  />
);

describe('conversation-only font size', () => {
  it('keeps the input and conversation controls at their fixed sizes', () => {
    const inputCss = readFileSync(
      repoPath('packages/ai-chat/src/components/MessageInput/index.module.css'),
      'utf8',
    );
    const rules = [...inputCss.matchAll(/\.messageTextarea\s*\{([^}]+)\}/g)];
    expect(rules.at(-1)?.[1]).toContain('font-size: 14px');
    expect(inputCss).not.toContain('--composer-text');
    const conversationCss = readFileSync(
      repoPath('packages/ai-chat/src/components/Conversation/index.module.css'),
      'utf8',
    );
    expect(conversationCss).toContain('--conv-ui: 14px');
    expect(conversationCss).toContain('--conv-meta: 13px');
  });

  it('defaults to 14, persists and clamps invalid values to 10–20px', () => {
    localStorage.clear();
    expect(getConversationFontSize()).toBe(14);
    setConversationFontSize(16);
    expect(getConversationFontSize()).toBe(16);
    expect(localStorage.getItem('ai-chat:conversationFontSize')).toBe('16');
    setConversationFontSize(100);
    expect(getConversationFontSize()).toBe(20);
    setConversationFontSize(1);
    expect(getConversationFontSize()).toBe(10);
    setConversationFontSize(NaN);
    expect(getConversationFontSize()).toBe(14);
    for (const invalid of ['garbage', '']) {
      localStorage.setItem('ai-chat:conversationFontSize', invalid);
      expect(getConversationFontSize()).toBe(14);
    }
  });

  it('does not reuse the input preference for conversation text', () => {
    localStorage.clear();
    localStorage.setItem('ai-chat:inputFontSize', '20');
    expect(getConversationFontSize()).toBe(14);
  });

  it('updates every mounted conversation immediately without changing the input or global tokens', () => {
    const r = render(
      <>
        {conversation('ordinary')}
        {conversation('coding')}
        <MessageInput onSend={vi.fn()} />
        <ConversationFontSizeSettings />
      </>,
    );
    for (const root of r.getAllByTestId('conversation')) {
      expect(root.style.getPropertyValue('--conv-text')).toBe('14px');
      expect(root.style.getPropertyValue('--conv-leading')).toBe('22px');
    }
    fireEvent.change(r.getByTestId('conversation-font-size'), { target: { value: '18' } });
    for (const root of r.getAllByTestId('conversation')) {
      expect(root.style.getPropertyValue('--conv-text')).toBe('18px');
      expect(root.style.getPropertyValue('--conv-leading')).toBe('26px');
    }
    expect(localStorage.getItem('ai-chat:conversationFontSize')).toBe('18');
    expect(r.getByTestId('conversation-font-size').textContent).toContain('18px');
    const input = r.getByTestId('chat-input');
    expect(input.style.getPropertyValue('--composer-text')).toBe('');
    expect(input.style.getPropertyValue('--conv-text')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--cd-font-size-md')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--conv-text')).toBe('');
  });

  it('remains reactive when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const r = render(conversation());
    act(() => setConversationFontSize(15));
    expect(r.getByTestId('conversation').style.getPropertyValue('--conv-text')).toBe('15px');
  });

  it('accepts a saved size from another window', () => {
    const r = render(conversation());
    localStorage.setItem('ai-chat:conversationFontSize', '17');
    fireEvent(window, new StorageEvent('storage', { key: 'ai-chat:conversationFontSize' }));
    expect(r.getByTestId('conversation').style.getPropertyValue('--conv-text')).toBe('17px');
  });
});
