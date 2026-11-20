// @vitest-environment happy-dom
/**
 * #408：Nomi 流式发送出错（仅写错误卡片、未设 global error）或主动停止（stopGeneration）时，
 * 结束后的结果记录为 error / stopped，绝不标进 doneConvos 显示绿色完成圆点。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import {
  prepareConversationStore,
  resetPreparedConversationStore,
} from '../src/services/conversationBoot';
import { createMemoryConversationKernel } from '../src/services/conversationKernel';
import type { SdkIPCClient } from '../src/services/IPCClient';

import type { ApiMockState } from './helpers/knowledgeApi';

const apiMock = vi.hoisted(() => ({ transport: false }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(apiMock),
);

type Api = ReturnType<typeof useAiChat>;

function mountClient(mode: 'ok' | 'fail' | 'hang') {
  let release: (() => void) | undefined;
  const client = {
    chat: {
      agentStream: vi.fn(() =>
        (async function* () {
          yield { type: 'delta', content: 'partial' };
          if (mode === 'fail') throw new Error('upstream boom');
          if (mode === 'hang') {
            await new Promise<void>((r) => {
              release = r;
            });
          }
        })(),
      ),
      stream: vi.fn(),
      sendMessage: vi.fn(),
      abort: vi.fn(),
      steer: vi.fn(async () => false),
    },
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  } as unknown as ClientAIClient;

  const ref: { api?: Api } = {};
  const Probe = () => {
    ref.api = useAiChat();
    return null;
  };
  const r = render(
    <AiChatContextProvider client={client}>
      <Probe />
    </AiChatContextProvider>,
  );
  return { ref: ref as { api: Api }, unmount: r.unmount, release: () => release?.() };
}

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe('Nomi 发送结局 outcome (#408)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    resetPreparedConversationStore();
    vi.restoreAllMocks();
    cleanup();
  });

  it('流式报错写入错误卡片时记为 error，不进 doneConvos', async () => {
    const kernel = createMemoryConversationKernel();
    await prepareConversationStore({ kernel });
    const ui = mountClient('fail');
    await tick();
    const ipc = ui.ref.api.state.ipcClient as SdkIPCClient;
    const id = ipc.conversationStore().create().id;
    ipc.conversationStore().switchTo(id);
    await act(async () => {
      await ui.ref.api.actions.loadChatHistory();
    });

    await act(async () => {
      await ui.ref.api.actions.sendStreamMessage('触发报错');
    });
    expect(ui.ref.api.state.doneConvos).toEqual([]);
    expect(ui.ref.api.state.convoOutcomes?.[id]).toBe('error');
  });

  it('主动调用 stopGeneration 中止生成时记为 stopped，不进 doneConvos', async () => {
    const kernel = createMemoryConversationKernel();
    await prepareConversationStore({ kernel });
    const ui = mountClient('hang');
    await tick();
    const ipc = ui.ref.api.state.ipcClient as SdkIPCClient;
    const id = ipc.conversationStore().create().id;
    ipc.conversationStore().switchTo(id);
    await act(async () => {
      await ui.ref.api.actions.loadChatHistory();
    });

    let sending!: Promise<void>;
    await act(async () => {
      sending = ui.ref.api.actions.sendStreamMessage('半路停下');
      await new Promise((r) => setTimeout(r, 20));
    });
    act(() => {
      ui.ref.api.actions.stopGeneration();
      ui.release();
    });
    await act(async () => {
      await sending;
    });
    expect(ui.ref.api.state.doneConvos).toEqual([]);
    expect(ui.ref.api.state.convoOutcomes?.[id]).toBe('stopped');
  });

  it('正常完成记为 done 且进 doneConvos', async () => {
    const kernel = createMemoryConversationKernel();
    await prepareConversationStore({ kernel });
    const ui = mountClient('ok');
    await tick();
    const ipc = ui.ref.api.state.ipcClient as SdkIPCClient;
    const id = ipc.conversationStore().create().id;
    ipc.conversationStore().switchTo(id);
    await act(async () => {
      await ui.ref.api.actions.loadChatHistory();
    });

    await act(async () => {
      await ui.ref.api.actions.sendStreamMessage('正常问答');
    });
    expect(ui.ref.api.state.doneConvos).toEqual([id]);
    expect(ui.ref.api.state.convoOutcomes?.[id]).toBe('done');
  });
});
