import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INSPECT_TIMEOUT_MS,
  cliUpdateClient,
  inspectGeneration,
} from '../src/services/cliUpdateClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cliUpdateClient.resetCache();
  resetFakeApi();
  vi.useRealTimers();
});

describe('cliUpdateClient.inspect', () => {
  it('times out the shared promise instead of leaving it pending', async () => {
    vi.useFakeTimers();
    installFakeApi(async (ch: string) => {
      if (ch === 'cliUpdate.inspect') return new Promise(() => undefined);
      return null;
    });
    const p = cliUpdateClient.inspect(false);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(INSPECT_TIMEOUT_MS);
    await assertion;
    // 超时后共享槽位已清空，下次可以再查
    installFakeApi(async (ch: string) => {
      if (ch === 'cliUpdate.inspect')
        return [
          {
            kind: 'claude',
            path: null,
            version: null,
            latest: null,
            updateAvailable: false,
            updateSupported: true,
          },
        ];
      return null;
    });
    await expect(cliUpdateClient.inspect(false)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'claude' })]),
    );
  });

  it('on timeout, returns the last cached result when one exists', async () => {
    installFakeApi(async (ch: string) => {
      if (ch === 'cliUpdate.inspect')
        return [
          {
            kind: 'claude',
            path: '/usr/bin/claude',
            version: '2.1.0',
            latest: null,
            updateAvailable: false,
            updateSupported: true,
          },
        ];
      return null;
    });
    const first = await cliUpdateClient.inspect(false);
    expect(first[0]?.path).toBe('/usr/bin/claude');
    const epoch = inspectGeneration();

    vi.useFakeTimers();
    installFakeApi(async (ch: string) => {
      if (ch === 'cliUpdate.inspect') return new Promise(() => undefined);
      return null;
    });
    const p = cliUpdateClient.inspect(true);
    await vi.advanceTimersByTimeAsync(INSPECT_TIMEOUT_MS);
    await expect(p).resolves.toEqual(first);
    expect(inspectGeneration()).toBe(epoch);
  });
});
