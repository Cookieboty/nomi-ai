/**
 * 故障转移的可见性（2.1.1 测试报告）：消息底部写实际回答的那一家、不到 0.1 秒的耗时照实写、
 * 网关重连 / 换供应商时等待态说明原因。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryStatus } from '../src/hooks/useGatewayRetry';
import { refreshNomiModel, servedModelLabel } from '../src/services/nomiModel';
import { providerClient } from '../src/services/providerClient';
import { chunkToUsage } from '../src/utils/chunkTrace';
import { deriveStatus } from '../src/utils/convStatus';
import { turnSummary } from '../src/utils/convTime';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const gateway = {
  providers: [
    {
      id: 'prova',
      name: 'ProvA',
      enabled: true,
      source: 'user',
      models: [{ id: 'm', enabled: true }],
    },
    {
      id: 'provb',
      name: 'ProvB',
      enabled: true,
      source: 'user',
      models: [{ id: 'm', enabled: true, label: 'Model M' }],
    },
  ],
  clients: { nomi: { models: { main: 'prova/m' } } },
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
};

afterEach(() => resetFakeApi());

describe('failover display', () => {
  it('footer label follows the provider that actually answered', async () => {
    installFakeApi((name: string) =>
      name === 'gateway.state'
        ? gateway
        : name === 'providers.state'
          ? { providers: [], envProviders: [], effectiveProviderId: 'nomi-gateway' }
          : {},
    );
    await providerClient.state();
    refreshNomiModel();
    await new Promise((r) => setTimeout(r, 0));
    expect(servedModelLabel('provb/m')).toBe('ProvB · Model M');
    // 认不出来（没有 / 或供应商已删）：退回选中的模型
    expect(servedModelLabel(undefined)).toBe('ProvA · m');
    expect(servedModelLabel('gone/m')).toBe('ProvA · m');
  });

  it('usage chunks keep the served model', () => {
    expect(chunkToUsage({ type: 'usage', usage: { promptTokens: 1 }, model: 'provb/m' })).toEqual({
      inputTokens: 1,
      model: 'provb/m',
    });
  });

  it('sub-100 ms turns show their real duration instead of 0ms', () => {
    expect(turnSummary({ durationMs: 30 })?.duration).toBe('30ms');
    expect(turnSummary({ durationMs: 0 })?.duration).toBe('1ms');
    expect(turnSummary({ durationMs: 16_040 })?.duration).toBe('16s');
  });

  it('retry / switch events become the waiting status', () => {
    const same = retryStatus({
      client: 'nomi',
      provider: 'ProvA',
      previous: 'ProvA',
      status: 503,
      attempt: 2,
      waitMs: 1500,
    });
    expect(same).toMatchObject({ kind: 'retry', attempt: 2, text: 'ProvA 返回 503，2 秒后重连' });
    const sw = retryStatus({
      client: 'nomi',
      provider: 'ProvB',
      previous: 'ProvA',
      status: 503,
      attempt: 7,
    });
    expect(sw).toMatchObject({ label: '正在换到 ProvB', text: 'ProvA 返回 503，换到 ProvB 继续' });
    const st = deriveStatus({
      phase: 'running',
      live: { text: '', startedAt: 0, status: sw },
      items: [],
    });
    expect(st).toMatchObject({ kind: 'retry', label: '正在换到 ProvB' });
    expect(
      deriveStatus({ phase: 'running', live: { text: '', startedAt: 0, status: same }, items: [] }),
    ).toMatchObject({ label: '请求失败，正在重试 (2)' });
  });
});
