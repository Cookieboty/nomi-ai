// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../src/components/Conversation/Messages';
import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { fromHarnessMessage } from '../src/utils/convAdapters';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

// 后台子代理完成后 CLI 自发的一轮（docs/design/cli-subagents.md §4）
describe('CLI 自发的跟进轮次', () => {
  afterEach(() => {
    cleanup();
    resetFakeApi();
  });

  it('CLI 标签消息带 origin=background：会话里标注「后台任务完成后的跟进」', () => {
    const conv = fromHarnessMessage(
      { id: 'b1', role: 'assistant', content: 'FOLLOWUP', timestamp: 1, origin: 'background' },
      'claude',
    );
    expect(conv.origin).toBe('background');
    const { getByTestId, getByText } = render(<AssistantMessage message={conv} />);
    expect(getByTestId('background-followup-note').textContent).toContain('后台任务完成后的跟进');
    expect(getByText('FOLLOWUP')).toBeTruthy();
  });

  it('主标签的自发轮次经 tab-message 广播：追加到当前对话并保存', async () => {
    const fake = installFakeApi(() => null);
    const client = {
      chat: { agentStream: vi.fn(), stream: vi.fn(), sendMessage: vi.fn(), abort: vi.fn() },
      memory: { userProfile: { get: () => undefined, set: vi.fn() } },
      dispose: vi.fn(),
    } as unknown as ClientAIClient;
    const ref: { api?: ReturnType<typeof useAiChat> } = {};
    const Probe = () => {
      ref.api = useAiChat();
      return null;
    };
    render(
      <AiChatContextProvider client={client}>
        <Probe />
      </AiChatContextProvider>,
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const save = vi.spyOn(ref.api!.state.ipcClient, 'saveMessage');
    const emit = (p: unknown) => fake.emit('harness.tabMessage', p);
    await act(() =>
      emit({
        tabId: 'main',
        message: {
          id: 'f1',
          role: 'assistant',
          content: 'FOLLOWUP',
          timestamp: 2,
          origin: 'background',
        },
      }),
    );
    // 别的标签 / 普通消息不走这里
    await act(() =>
      emit({
        tabId: 'tab-x',
        message: { id: 'f2', role: 'assistant', content: 'X', timestamp: 3, origin: 'background' },
      }),
    );
    const msgs = ref.api!.state.messages;
    expect(msgs.map((m) => [m.content, m.origin])).toEqual([['FOLLOWUP', 'background']]);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
