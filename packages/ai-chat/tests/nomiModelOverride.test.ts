/**
 * NOMI_PROVIDER 锁定 provider 时，消息标签 / 能力判断跟着锁定的 provider，不用网关分配（#91）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nomiModelLabel, nomiModelMeta, refreshNomiModel } from '../src/services/nomiModel';
import { providerClient } from '../src/services/providerClient';

const gateway = {
  providers: [
    {
      id: 'gw',
      name: 'GW',
      enabled: true,
      source: 'user',
      models: [{ id: 'vision', enabled: true, label: 'Vision', vision: true }],
    },
  ],
  clients: { nomi: { models: { main: 'gw/vision' } } },
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
};

function bridge(override?: string) {
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'ai:gateway:state') return gateway;
    if (ch === 'ai:providers:state')
      return {
        providers: [{ id: 'ds', name: 'DeepSeek' }],
        envProviders: [],
        effectiveProviderId: override ? 'ds' : 'nomi-gateway',
        effectiveModel: override ? 'deepseek-chat' : undefined,
        ...(override ? { overrideId: override } : {}),
      };
    return {};
  });
  (globalThis as { window?: unknown }).window = { aiIPC: { invoke, on: vi.fn(() => () => {}) } };
}

const load = async (override?: string) => {
  bridge(override);
  await providerClient.state();
  refreshNomiModel();
  await new Promise((r) => setTimeout(r, 0));
};

describe('nomiModel with NOMI_PROVIDER override (#91)', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('labels messages with the locked provider and reports unknown capabilities', async () => {
    await load('ds');
    expect(nomiModelLabel()).toBe('DeepSeek · deepseek-chat');
    expect(nomiModelMeta()).toBeUndefined();
  });

  it('without an override the gateway assignment is used', async () => {
    await load();
    expect(nomiModelLabel()).toContain('Vision');
    expect(nomiModelMeta()?.id).toBe('vision');
  });
});
