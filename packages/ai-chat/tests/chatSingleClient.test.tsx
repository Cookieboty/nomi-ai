// @vitest-environment happy-dom
/**
 * 对话窗口只用外层 <AIProvider> 的那一个 ClientAIClient：AiChatContextProvider 的首屏状态
 * 直接绑定传入的 client，不再另建一个自带 ClientAIClient 的 IPCClient（每个 ClientAIClient
 * 在主进程占一个契约会话，见 contract 的 maxSessionsPerSender）。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constructed = vi.hoisted(() => ({ count: 0 }));

vi.mock('@nomi-ai/ai-sdk-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class CountingClient {
    constructor() {
      constructed.count += 1;
    }
  }
  return { ...actual, ClientAIClient: CountingClient };
});

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { SdkIPCClient } from '../src/services/IPCClient';

describe('AiChatContextProvider · 单一 ClientAIClient', () => {
  beforeEach(() => {
    constructed.count = 0;
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it('传入 client 时首屏与之后都绑定它，不另建 ClientAIClient', () => {
    const client = {
      chat: {},
      memory: { userProfile: { get: () => undefined, set: vi.fn() } },
      dispose: vi.fn(),
    } as unknown as ClientAIClient;
    const seen: unknown[] = [];
    const Probe = () => {
      seen.push(useAiChat().state.ipcClient);
      return null;
    };
    const { rerender } = render(
      <AiChatContextProvider client={client}>
        <Probe />
      </AiChatContextProvider>,
    );
    rerender(
      <AiChatContextProvider client={client}>
        <Probe />
      </AiChatContextProvider>,
    );

    expect(constructed.count).toBe(0);
    expect(new Set(seen).size).toBe(1);
    const ipc = seen[0] as SdkIPCClient & { client: unknown };
    expect(ipc).toBeInstanceOf(SdkIPCClient);
    expect(ipc.client).toBe(client);
  });
});
