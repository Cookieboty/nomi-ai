// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/mascot/catalog', async (orig) => ({
  ...(await orig<typeof import('../../src/mascot/catalog')>()),
  loadCatalog: () => new Promise(() => undefined),
}));

import { MascotProvider, useMascot } from '../../src/contexts/MascotContext';
import { useCompanionMessage } from '../../src/hooks/useCompanionMessage';
import { GREETING_DELAY_MS, GREETING_PRIORITY, useMascotTips } from '../../src/hooks/useMascotTips';

type Api = {
  show: ReturnType<typeof useCompanionMessage>['showMessage'];
  dispatch: ReturnType<typeof useMascot>['dispatch'];
  msg: string | null;
};
const api: Api = { show: () => undefined, dispatch: () => undefined, msg: null };
const Probe: React.FC = () => {
  const { showMessage } = useCompanionMessage();
  const { state, dispatch } = useMascot();
  api.show = showMessage;
  api.dispatch = dispatch;
  api.msg = state.currentMessage;
  return null;
};
const Tips: React.FC = () => {
  useMascotTips();
  return null;
};

describe('mascot bubble priority', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('the startup greeting ranks below AI replies', () => {
    expect(GREETING_PRIORITY).toBeLessThan(9);
  });

  it('a reply shown before the greeting delay is not replaced by the greeting (E12)', () => {
    render(
      <MascotProvider config={{}}>
        <Probe />
        <Tips />
      </MascotProvider>,
    );
    act(() => vi.advanceTimersByTime(100));
    act(() => api.show('第一句话在这里。', 15_000, 9, false, { more: true }));
    act(() => vi.advanceTimersByTime(GREETING_DELAY_MS + 500));
    expect(api.msg).toBe('第一句话在这里。');
  });

  it('a rejected lower-priority line does not shorten the shown line', () => {
    render(
      <MascotProvider config={{}}>
        <Probe />
      </MascotProvider>,
    );
    act(() => api.show('reply', 10_000, 9));
    // straight to the provider's dispatch, as a caller holding a stale showMessage would
    act(() =>
      api.dispatch({ type: 'SET_MESSAGE', payload: { text: 'low', priority: 1, timeout: 500 } }),
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(api.msg).toBe('reply');
    act(() => vi.advanceTimersByTime(9_000));
    expect(api.msg).toBeNull();
  });
});
