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
  it('新会话默认显示思考（thinking）', () => {
    expect(getGlobalTranscriptView()).toBe('thinking');
    expect(getTranscriptView('tab:a')).toBe('thinking');
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
    expect(getGlobalTranscriptView()).toBe('thinking');
    expect(getTranscriptView('tab:a')).toBe('thinking');
    expect(getSessionTranscriptView('tab:b')).toBeNull();
  });

  it('localStorage 写不进去时，本次运行内仍然生效', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      setTranscriptView('tab:a', 'verbose');
      expect(getTranscriptView('tab:a')).toBe('verbose');
      setGlobalTranscriptView('normal');
      expect(getTranscriptView('tab:b')).toBe('normal');
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});
