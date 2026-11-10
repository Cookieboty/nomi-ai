// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearTranscriptView,
  getGlobalTranscriptView,
  getSessionTranscriptView,
  getTranscriptView,
  resetTranscriptViewsForTest,
  setGlobalTranscriptView,
  setTranscriptView,
} from '../src/services/transcriptView';

beforeEach(() => resetTranscriptViewsForTest());

describe('Transcript view 的全局默认与会话覆盖', () => {
  it('新会话默认 Normal', () => {
    expect(getGlobalTranscriptView()).toBe('normal');
    expect(getTranscriptView('tab:a')).toBe('normal');
    expect(getSessionTranscriptView('tab:a')).toBeNull();
  });

  it('会话级覆盖优先于全局设置，并且只影响该会话', () => {
    setGlobalTranscriptView('thinking');
    setTranscriptView('tab:a', 'verbose');
    expect(getTranscriptView('tab:a')).toBe('verbose');
    expect(getTranscriptView('tab:b')).toBe('thinking');
    expect(getSessionTranscriptView('tab:a')).toBe('verbose');
  });

  it('改全局设置不会覆盖已有会话的单独选择', () => {
    setTranscriptView('tab:a', 'verbose');
    setGlobalTranscriptView('thinking');
    expect(getTranscriptView('tab:a')).toBe('verbose');
    expect(getTranscriptView('tab:b')).toBe('thinking');
  });

  it('清除会话覆盖后重新跟随全局', () => {
    setGlobalTranscriptView('thinking');
    setTranscriptView('tab:a', 'verbose');
    clearTranscriptView('tab:a');
    expect(getSessionTranscriptView('tab:a')).toBeNull();
    expect(getTranscriptView('tab:a')).toBe('thinking');
  });

  it('从 localStorage 读回；无效值按默认处理', () => {
    setGlobalTranscriptView('verbose');
    setTranscriptView('tab:a', 'thinking');
    expect(getGlobalTranscriptView()).toBe('verbose');
    expect(getTranscriptView('tab:a')).toBe('thinking');

    window.localStorage.setItem(
      'nomi.transcriptView.v1',
      JSON.stringify({ global: 'bogus', sessions: { 'tab:a': 'bogus', 'tab:b': 'yes' } }),
    );
    expect(getGlobalTranscriptView()).toBe('normal');
    expect(getTranscriptView('tab:a')).toBe('normal');
    expect(getSessionTranscriptView('tab:b')).toBeNull();
  });
});
