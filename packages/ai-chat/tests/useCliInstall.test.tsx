// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCliInstall } from '../src/components/ModelsPage/useCliInstall';
import { cliUpdateClient } from '../src/services/cliUpdateClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  cliUpdateClient.resetCache();
  resetFakeApi();
});

describe('useCliInstall', () => {
  it('inspect 失败时把 infos 设成空数组，离开「正在检查」（anyInstalled 不再是 null）', async () => {
    installFakeApi(async (ch: string) => {
      if (ch === 'cliUpdate.inspect') throw new Error('UNAVAILABLE');
      if (ch === 'cliUpdate.busy') return [];
      return null;
    });
    const { result } = renderHook(() => useCliInstall(() => undefined));
    expect(result.current.anyInstalled).toBeNull();
    await waitFor(() => expect(result.current.anyInstalled).toBe(false));
    expect(result.current.missing('claude')).toBe(false);
    expect(result.current.installed('claude')).toBe(false);
  });
});
