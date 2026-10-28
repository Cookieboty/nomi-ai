// @vitest-environment happy-dom
import type { Router } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __setMascotShownForTest,
  closeMascot,
  initMascotPresence,
  isMascotMuted,
  useMascotShown,
} from '../../src/mascot/presence';
import * as apiModule from '../../src/services/api';

// 契约替身（D2 `startup.*`）：看板娘窗口的调用者身份，startup 的读写由每个用例给
const h = vi.hoisted(() => ({
  get: (): unknown => ({ defaultView: 'mascot', closeMain: 'hide', showMascot: true }),
  set: (_patch: unknown): unknown => ({
    defaultView: 'main',
    closeMain: 'hide',
    showMascot: false,
  }),
}));

vi.mock('../../src/services/api', async () => {
  const { appContract } = await import('@nomi-ai/contract/app');
  const { createTestClient } = await import('@nomi-ai/contract/testing');
  const client = createTestClient(
    appContract,
    {
      'startup.get': () => h.get() as never,
      'startup.set': (patch) => h.set(patch) as never,
    },
    { caller: { surface: 'mascot', trusted: true } },
  );
  return {
    api: client.api,
    router: client.router,
    hasTransport: () => true,
    hasWindowHost: () => true,
    installHostBackends: () => undefined,
  };
});

const router = (apiModule as unknown as { router: Router<AppContract> }).router;
const Probe: React.FC = () => <span data-testid="shown">{String(useMascotShown())}</span>;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  cleanup();
  __setMascotShownForTest(true);
});

describe('mascot presence (#55)', () => {
  it('follows startup.changed: hidden → muted and hooks re-render', async () => {
    initMascotPresence();
    render(<Probe />);
    expect(screen.getByTestId('shown').textContent).toBe('true');
    await act(tick);
    // 默认界面为看板娘时关闭：主进程把默认界面改为 main 并广播
    await act(async () => {
      router.events.publish('startup.changed', {
        defaultView: 'main',
        closeMain: 'hide',
        showMascot: false,
      });
      await tick();
    });
    await waitFor(() => expect(screen.getByTestId('shown').textContent).toBe('false'));
    expect(isMascotMuted()).toBe(true);
    await act(async () => {
      router.events.publish('startup.changed', {
        defaultView: 'main',
        closeMain: 'hide',
        showMascot: true,
      });
      await tick();
    });
    await waitFor(() => expect(isMascotMuted()).toBe(false));
  });

  it('closeMascot reports success only when the main process confirms', async () => {
    const set = vi.fn(() => ({ defaultView: 'main', closeMain: 'hide', showMascot: false }));
    h.set = set;
    expect(await closeMascot()).toBe(true);
    expect(set).toHaveBeenCalledWith({ showMascot: false });
    h.set = () => {
      throw new Error('nope');
    };
    expect(await closeMascot()).toBe(false);
  });
});
