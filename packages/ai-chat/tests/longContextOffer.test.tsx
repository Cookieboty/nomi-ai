// @vitest-environment happy-dom
/**
 * 上下文环的长上下文提议（docs/design/unified-gateway.md §12.7.2）：第三方模型快到标准窗口
 * （CLI 将自动压缩）时，悬停浮窗里就地提议开启长上下文，并写清价格。
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextUsageBar } from '../src/components/SessionWorkspace/ContextUsageBar';
import type { HarnessTabMeta } from '../src/services/harnessClient';
import type { ConvMessage } from '../src/types/conversation';

const REF = 'amux/openai/gpt-6.1-sol';
const tabRef: { current: HarnessTabMeta } = {
  current: {
    id: 'cx',
    title: 'X',
    backend: 'claude',
    cwd: '/w',
    cliSessionId: null,
    status: 'idle',
    unread: 0,
    createdAt: 0,
    updatedAt: 0,
    permissionMode: 'default',
    source: 'thirdParty',
    modelOverride: REF,
  },
};

vi.mock('../src/contexts/HarnessTabsContext', () => ({
  useHarnessTabs: () => ({ isCliTab: true, activeTab: tabRef.current }),
}));

const gatewayState = {
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [
    {
      id: 'amux',
      name: 'Amux',
      enabled: true,
      urls: {},
      keys: [],
      models: [
        {
          id: 'openai/gpt-6.1-sol',
          enabled: true,
          effective: {
            ctx: 272_000,
            maxOutput: 128_000,
            source: 'catalog',
            maxOutputSource: 'catalog',
            longContext: {
              standard: 272_000,
              full: 922_000,
              on: false,
              price: { size: 272_000, input: 2, output: 10, tierInput: 4, tierOutput: 15 },
            },
          },
        },
      ],
    },
  ],
  clients: { claude: { models: {} } },
  allowedPrivateHosts: [],
  port: 1,
};

/** 一条带 CLI 上报用量的助手消息：上下文 used / 窗口（默认 272K，Claude 上报的是注入的标准窗口） */
const messages = (used: number, contextWindow = 272_000): ConvMessage[] => [
  {
    id: 'a1',
    role: 'assistant',
    content: 'ok',
    timestamp: 0,
    usage: { contextTokens: used, contextWindow },
  } as unknown as ConvMessage,
];

function setup(used: number, contextWindow?: number) {
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'ai:gateway:state') return gatewayState;
    if (ch === 'ai:harness:tab-long-context') return { ...tabRef.current };
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  const r = render(<ContextUsageBar messages={messages(used, contextWindow)} model={REF} />);
  return { invoke, r };
}

afterEach(cleanup);

describe('上下文环 · 长上下文提议', () => {
  it('超过标准窗口的 70%：环上有提醒点，悬停可一键开启，价格写清楚', async () => {
    const { invoke, r } = setup(200_000);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
    await act(async () => {});
    const bar = r.getByTestId('context-usage-bar');
    await waitFor(() => expect(bar.getAttribute('data-long-offer')).toBe('true'));
    fireEvent.mouseEnter(bar);
    const detail = r.getByTestId('context-usage-detail');
    // 带按钮时不再是纯提示
    expect(detail.getAttribute('role')).toBe('dialog');
    expect(r.getByTestId('long-context-offer').textContent).toContain(
      '超过 272K 的请求按输入 $4/M（标准 $2/M）计费',
    );
    fireEvent.click(r.getByTestId('long-context-enable'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:harness:tab-long-context', 'cx', true),
    );
  });

  it('还远没到标准窗口：不打扰', async () => {
    const { invoke, r } = setup(50_000);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
    await act(async () => {});
    const bar = r.getByTestId('context-usage-bar');
    expect(bar.getAttribute('data-long-offer')).toBeNull();
    fireEvent.mouseEnter(bar);
    expect(r.queryByTestId('long-context-offer')).toBeNull();
    expect(r.getByTestId('context-usage-detail').getAttribute('role')).toBe('tooltip');
  });

  it('上一轮上报的是换模型之前的窗口：显示新模型下次启动会注入的窗口', async () => {
    // 上一轮跑的是不在目录里的模型：Codex 按 128K 的 95% 上报 121.6K；之后标签换成了 gpt-6.1-sol
    const { invoke, r } = setup(23_700, 121_600);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
    await act(async () => {});
    fireEvent.mouseEnter(r.getByTestId('context-usage-bar'));
    await waitFor(() =>
      expect(r.getByTestId('context-usage-detail').textContent).toContain('23.7K / 272K'),
    );
  });

  it('Codex 上报的是注入值的 95%：仍按上报的显示', async () => {
    const { invoke, r } = setup(23_700, 258_400);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
    await act(async () => {});
    fireEvent.mouseEnter(r.getByTestId('context-usage-bar'));
    expect(r.getByTestId('context-usage-detail').textContent).toContain('/ 258K');
  });

  it('已经开着长上下文：不再提议', async () => {
    tabRef.current = { ...tabRef.current, longContext: { model: REF, on: true } };
    const { invoke, r } = setup(260_000);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:gateway:state'));
    await act(async () => {});
    expect(r.getByTestId('context-usage-bar').getAttribute('data-long-offer')).toBeNull();
  });
});
