import { afterEach, describe, expect, it, vi } from 'vitest';

import { providerClient } from '../src/services/providerClient';

describe('providerClient', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('invokes ai:providers:* and strips Electron error prefix', async () => {
    const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
      if (ch === 'ai:providers:setActive' && a[0] === 'x')
        throw new Error(
          "Error invoking remote method 'ai:providers:setActive': Error: provider 'x' 不存在",
        );
      return { providers: [], envProviders: [] };
    });
    (globalThis as { window?: unknown }).window = { aiIPC: { invoke, on: vi.fn() } };
    await providerClient.setActive('p-1');
    expect(invoke).toHaveBeenCalledWith('ai:providers:setActive', 'p-1', undefined);
    await providerClient.setActive('p-1', 'm-2');
    expect(invoke).toHaveBeenLastCalledWith('ai:providers:setActive', 'p-1', 'm-2');
    await expect(providerClient.setActive('x')).rejects.toThrow("provider 'x' 不存在");
  });

  it('only exposes the remaining read / switch methods', () => {
    expect(Object.keys(providerClient).sort()).toEqual(
      ['onChanged', 'onOpenPanel', 'presets', 'setActive', 'state'].sort(),
    );
  });
});
