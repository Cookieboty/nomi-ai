import { describe, expect, it } from 'vitest';

import { sameMetaList } from '../src/components/Sidebar/listEquality';
import type { Meta } from '../src/components/Sidebar/types';
import { aiChatReducer, type AiChatState } from '../src/contexts/AiChatContext';

const meta = (id: string, o: Partial<Meta> = {}): Meta => ({
  id,
  name: `会话 ${id}`,
  backend: 'nomi',
  createdAt: 1,
  updatedAt: 10,
  ...o,
});

describe('SET_ERROR reducer', () => {
  const base = { messages: [], isLoading: false, streaming: false } as unknown as AiChatState;

  it('returns the same state when the error is unchanged', () => {
    expect(aiChatReducer(base, { type: 'SET_ERROR', payload: undefined })).toBe(base);
    const withErr = { ...base, error: 'boom' };
    expect(aiChatReducer(withErr, { type: 'SET_ERROR', payload: 'boom' })).toBe(withErr);
  });

  it('returns a new state when the error changes', () => {
    const next = aiChatReducer(base, { type: 'SET_ERROR', payload: 'boom' });
    expect(next).not.toBe(base);
    expect(next.error).toBe('boom');
    expect(aiChatReducer(next, { type: 'SET_ERROR', payload: undefined }).error).toBeUndefined();
  });
});

describe('sidebar list equality (refresh skip)', () => {
  it('treats freshly fetched copies with identical fields as equal', () => {
    const a = [meta('1'), meta('2', { tabId: 't2', backend: 'codex', cliSessionId: 's' })];
    const b = a.map((x) => ({ ...x }));
    expect(sameMetaList(a, b)).toBe(true);
  });

  it.each<[string, Partial<Meta>]>([
    ['updatedAt', { updatedAt: 11 }],
    ['name', { name: '新名字' }],
    ['backend', { backend: 'claude' }],
    ['tabId', { tabId: 't9' }],
    ['cliSessionId', { cliSessionId: 'x' }],
    ['modelId', { modelId: 'm' }],
  ])('detects a change in %s', (_k, patch) => {
    const a = [meta('1'), meta('2')];
    expect(sameMetaList(a, [a[0]!, { ...a[1]!, ...patch }])).toBe(false);
  });

  it('detects reorder, insertion and removal', () => {
    const a = [meta('1'), meta('2')];
    expect(sameMetaList(a, [a[1]!, a[0]!])).toBe(false);
    expect(sameMetaList(a, [...a, meta('3')])).toBe(false);
    expect(sameMetaList(a, [a[0]!])).toBe(false);
  });
});
