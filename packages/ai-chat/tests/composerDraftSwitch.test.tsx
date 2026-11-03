// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useComposerDraftBinding } from '../src/hooks/useComposerDraftBinding';
import { SHARED_UNSENT, createComposerDraftStore } from '../src/services/composerDrafts';

describe('useComposerDraftBinding', () => {
  it('keeps shared text across empty sessions; isolates after send', () => {
    const store = createComposerDraftStore();
    const { result, rerender } = renderHook(({ key }) => useComposerDraftBinding(store, key), {
      initialProps: { key: SHARED_UNSENT },
    });
    act(() => result.current.setText('shared'));
    rerender({ key: SHARED_UNSENT }); // simulate switch empty→empty
    expect(result.current.text).toBe('shared');

    act(() => {
      result.current.clearActive(); // send
    });
    expect(store.read(SHARED_UNSENT).text).toBe('');

    // After send, App switches to the private key; follow-ups live there.
    rerender({ key: 'nomi:a' });
    expect(result.current.text).toBe('');
    act(() => result.current.setText('follow-a'));
    expect(result.current.text).toBe('follow-a');
    rerender({ key: 'nomi:b' });
    expect(result.current.text).toBe('');
    rerender({ key: 'nomi:a' });
    expect(result.current.text).toBe('follow-a');
  });
});
