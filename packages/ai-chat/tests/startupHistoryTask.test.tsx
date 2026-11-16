// @vitest-environment happy-dom
/**
 * 启动时历史还在加载，用户（或引导）新建了会话：historySeq 被推进后旧加载的结果作废，
 * 但开屏的 nomi 任务仍要报完成，否则回访启动一直停在品牌开屏（2.3.15 回归）。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { startupBrandIntro } from '../src/components/BrandIntro/state';
import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { SdkIPCClient } from '../src/services/IPCClient';

beforeEach(() => {
  startupBrandIntro.resetForTest();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  startupBrandIntro.resetForTest();
});

it('reports the startup history task done even when a new conversation supersedes the load', async () => {
  let resolveHistory: (v: never[]) => void = () => undefined;
  vi.spyOn(SdkIPCClient.prototype, 'getChatHistory').mockImplementation(
    () => new Promise((r) => (resolveHistory = r)),
  );
  vi.spyOn(SdkIPCClient.prototype, 'getConfig').mockResolvedValue({} as never);
  vi.spyOn(SdkIPCClient.prototype, 'newConversation').mockResolvedValue('c2' as never);
  const client = {
    chat: {},
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  } as unknown as ClientAIClient;
  startupBrandIntro.start('app');
  let actions: ReturnType<typeof useAiChat>['actions'] | undefined;
  const Probe = () => {
    actions = useAiChat().actions;
    return null;
  };
  render(
    <AiChatContextProvider client={client}>
      <Probe />
    </AiChatContextProvider>,
  );
  expect(startupBrandIntro.getSnapshot().pending).toContain('nomi');
  await act(async () => {
    await actions!.newConversation();
  });
  await act(async () => {
    resolveHistory([]);
    await Promise.resolve();
  });
  expect(startupBrandIntro.getSnapshot().pending).not.toContain('nomi');
});
