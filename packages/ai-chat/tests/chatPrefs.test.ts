// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';

import {
  getChatMode,
  setChatMode,
  getConversationListView,
  setConversationListView,
  getEndpointFilter,
  setEndpointFilter,
  getSmartTitle,
  setSmartTitle,
  subscribeSmartTitle,
} from '../src/services/chatPrefs';

describe('chatPrefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to normal mode and all list view', () => {
    expect(getChatMode()).toBe('normal');
    expect(getConversationListView()).toBe('all');
    expect(getEndpointFilter()).toBe('nomi');
  });

  it('persists mode and list view', () => {
    setChatMode('dev');
    setConversationListView('by-endpoint');
    setEndpointFilter('codex');
    expect(getChatMode()).toBe('dev');
    expect(getConversationListView()).toBe('by-endpoint');
    expect(getEndpointFilter()).toBe('codex');
  });
});

describe('smart chat titles', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to on; turning it off persists and notifies', () => {
    expect(getSmartTitle()).toBe(true);
    let n = 0;
    const off = subscribeSmartTitle(() => n++);
    setSmartTitle(false);
    expect(getSmartTitle()).toBe(false);
    expect(localStorage.getItem('ai-chat:smartTitle')).toBe('off');
    setSmartTitle(true);
    expect(getSmartTitle()).toBe(true);
    expect(n).toBe(2);
    off();
  });
});
