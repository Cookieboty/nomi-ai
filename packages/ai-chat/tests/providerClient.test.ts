import { afterEach, describe, expect, it, vi } from 'vitest';

import { providerClient } from '../src/services/providerClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

describe('providerClient', () => {
  afterEach(() => resetFakeApi());

  it('invokes providers.* and strips Electron error prefix', async () => {
    const invoke = vi.fn(async (name: string, i: { id?: string }) => {
      if (name === 'providers.setActive' && i.id === 'x')
        throw new Error(
          "Error invoking remote method 'ai:providers:setActive': Error: provider 'x' 不存在",
        );
      return { providers: [], envProviders: [] };
    });
    installFakeApi(invoke);
    await providerClient.setActive('p-1');
    expect(invoke).toHaveBeenCalledWith('providers.setActive', { id: 'p-1' });
    await providerClient.setActive('p-1', 'm-2');
    expect(invoke).toHaveBeenLastCalledWith('providers.setActive', { id: 'p-1', model: 'm-2' });
    await expect(providerClient.setActive('x')).rejects.toThrow("provider 'x' 不存在");
  });

  it('only exposes the remaining read / switch methods', () => {
    expect(Object.keys(providerClient).sort()).toEqual(
      ['onChanged', 'onOpenPanel', 'presets', 'setActive', 'state'].sort(),
    );
  });
});
