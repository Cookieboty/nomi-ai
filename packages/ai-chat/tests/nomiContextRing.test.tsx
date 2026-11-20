// @vitest-environment happy-dom
/**
 * 上下文环 · Nomi 对话：窗口取内核按路由到的模型算的预算（gateway.nomiContext），
 * 与自动压缩同一份；网关模型名（openai/gpt-6-astra）经验表认不出，用网关窗口，不用 128K 经验表。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextUsageBar } from '../src/components/SessionWorkspace/ContextUsageBar';
import { AiChatStoreContext, createAiChatStore } from '../src/contexts/aiChatStore';
import { resetGatewayStateCache } from '../src/services/nomiModel';
import type { ConvMessage } from '../src/types/conversation';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

vi.mock('../src/contexts/HarnessTabsContext', () => ({
  useHarnessTabs: () => ({ isCliTab: false, activeTab: null }),
  useHarnessTabsCore: () => ({ isCliTab: false, activeTab: null }),
}));

const gatewayState = {
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [],
  clients: { nomi: { models: { main: 'amux/openai/gpt-6-astra' } } },
  allowedPrivateHosts: [],
  port: 1,
};

const messages: ConvMessage[] = [
  { id: 'u1', role: 'user', content: 'hi', timestamp: 0 } as unknown as ConvMessage,
];

function setup(ctx: { window: number; source: string } | null) {
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'gateway.state') return gatewayState;
    if (ch === 'gateway.nomiContext')
      return ctx
        ? {
            model: 'amux/openai/gpt-6-astra',
            window: ctx.window,
            outputReserve: 32_000,
            budget: ctx.window - 32_000,
            compactAt: Math.floor((ctx.window - 32_000) * 0.95),
            source: ctx.source,
          }
        : null;
    return {};
  });
  installFakeApi(invoke);
  const r = render(<ContextUsageBar messages={messages} />);
  return { invoke, r };
}

afterEach(() => {
  cleanup();
  resetFakeApi();
  resetGatewayStateCache();
});

describe('上下文环 · Nomi 对话的窗口', () => {
  it('用网关给的模型窗口，不显示「未识别模型」', async () => {
    const { invoke, r } = setup({ window: 272_000, source: 'catalog' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('gateway.nomiContext', { role: 'chat' }),
    );
    await act(async () => {});
    fireEvent.mouseEnter(r.getByTestId('context-usage-bar'));
    await waitFor(() =>
      expect(r.getByTestId('context-usage-detail').textContent).toContain('/ 272K'),
    );
    expect(r.getByTestId('context-usage-detail').textContent).not.toContain('未识别模型');
  });

  it('网关也不认识这个模型：用网关的默认窗口并标注', async () => {
    const { invoke, r } = setup({ window: 262_144, source: 'default' });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('gateway.nomiContext', { role: 'chat' }),
    );
    await act(async () => {});
    fireEvent.mouseEnter(r.getByTestId('context-usage-bar'));
    const text = r.getByTestId('context-usage-detail').textContent ?? '';
    expect(text).toContain('/ 262K');
    expect(text).toContain('未识别模型');
  });

  it('会话开启长上下文后，上下文环将覆盖值传给 gateway.nomiContext', async () => {
    const gw = {
      ...gatewayState,
      providers: [
        {
          id: 'amux',
          name: 'Amux',
          enabled: true,
          urls: {},
          keys: [],
          models: [
            {
              id: 'openai/gpt-6-astra',
              enabled: true,
              effective: {
                ctx: 262_144,
                maxOutput: 128_000,
                source: 'catalog',
                maxOutputSource: 'catalog',
                longContext: { standard: 262_144, full: 1_048_576, on: false },
              },
            },
          ],
        },
      ],
    };
    const convo = {
      id: 'c1',
      backend: 'nomi',
      longContext: { model: 'amux/openai/gpt-6-astra', on: true },
    };
    const store = createAiChatStore({
      messages: [],
      ipcClient: {
        currentConversationId: () => 'c1',
        conversationStore: () => ({ get: (id: string) => (id === 'c1' ? convo : undefined) }),
      },
    } as never);
    const invoke = vi.fn(async (ch: string, input?: { longContext?: boolean }) => {
      if (ch === 'gateway.state') return gw;
      if (ch === 'gateway.nomiContext') {
        const w = input?.longContext ? 1_048_576 : 262_144;
        return {
          model: 'amux/openai/gpt-6-astra',
          window: w,
          outputReserve: 32_000,
          budget: w - 32_000,
          compactAt: Math.floor((w - 32_000) * 0.95),
          source: 'catalog',
        };
      }
      return {};
    });
    installFakeApi(invoke);
    const r = render(
      <AiChatStoreContext.Provider
        value={{ store, actions: {} as never, dispatch: () => undefined }}
      >
        <ContextUsageBar messages={messages} />
      </AiChatStoreContext.Provider>,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('gateway.nomiContext', {
        role: 'chat',
        longContext: true,
      }),
    );
    await act(async () => {});
    fireEvent.mouseEnter(r.getByTestId('context-usage-bar'));
    await waitFor(() =>
      expect(r.getByTestId('context-usage-detail').textContent).toContain('/ 1M'),
    );
  });
});
