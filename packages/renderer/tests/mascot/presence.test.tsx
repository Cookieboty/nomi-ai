// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  __setMascotShownForTest,
  closeMascot,
  initMascotPresence,
  isMascotMuted,
  useMascotShown,
} from '../../src/mascot/presence';

const Probe: React.FC = () => <span data-testid="shown">{String(useMascotShown())}</span>;

afterEach(() => {
  cleanup();
  __setMascotShownForTest(true);
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

describe('mascot presence (#55)', () => {
  it('follows ai:startup:changed: hidden → muted and hooks re-render', async () => {
    let push: ((p: unknown) => void) | null = null;
    (window as unknown as { aiIPC: unknown }).aiIPC = {
      invoke: async () => ({ defaultView: 'mascot', showMascot: true }),
      on: (_ch: string, fn: (p: unknown) => void) => {
        push = fn;
        return () => undefined;
      },
    };
    initMascotPresence();
    render(<Probe />);
    expect(screen.getByTestId('shown').textContent).toBe('true');
    // 默认界面为看板娘时关闭：主进程把默认界面改为 main 并广播
    act(() => push?.({ defaultView: 'main', showMascot: false }));
    expect(screen.getByTestId('shown').textContent).toBe('false');
    expect(isMascotMuted()).toBe(true);
    act(() => push?.({ defaultView: 'main', showMascot: true }));
    expect(isMascotMuted()).toBe(false);
  });

  it('closeMascot reports success only when the main process confirms', async () => {
    (window as unknown as { aiIPC: unknown }).aiIPC = {
      invoke: async () => ({ defaultView: 'main', showMascot: false }),
      on: () => () => undefined,
    };
    expect(await closeMascot()).toBe(true);
    (window as unknown as { aiIPC: unknown }).aiIPC = {
      invoke: async () => {
        throw new Error('nope');
      },
      on: () => () => undefined,
    };
    expect(await closeMascot()).toBe(false);
  });
});
