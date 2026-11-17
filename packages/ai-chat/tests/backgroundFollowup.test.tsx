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

// 后台子代理完成后 CLI 自发的一轮（docs/development/coding-agents.md）
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

  it('运行中收到被停止的委派：不注入也不留 interject；完成 / 失败才静默告知模型', async () => {
    const fake = installFakeApi(() => null);
    const steerCalls: Array<{ reqId: string; text: string }> = [];
    let release: (() => void) | null = null;
    const client = {
      chat: {
        agentStream: vi.fn(function () {
          return (async function* () {
            await new Promise<void>((r) => {
              release = r;
            });
            yield { type: 'delta', content: '收到' };
          })();
        }),
        stream: vi.fn(),
        sendMessage: vi.fn(),
        abort: vi.fn(),
        steer: vi.fn((reqId: string, text: string) => {
          steerCalls.push({ reqId, text });
          return Promise.resolve(true);
        }),
      },
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

    let turnDone: Promise<void> | undefined;
    act(() => {
      turnDone = ref.api!.actions.sendStreamMessage('review 当前项目');
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));

    // 用户在运行中把 CLI 停下：模型下一轮从历史里读得到，不再 steer 一遍（也不用假装是用户插话）
    await act(async () => {
      fake.emit('delegate.completed', {
        taskId: 't_stop',
        cli: 'claude',
        status: 'cancelled',
        cancelledBy: 'user',
        summary: '',
        filesVerified: false,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 30,
        background: true,
      });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(steerCalls).toEqual([]);
    expect(ref.api!.state.messages.some((m) => m.content.includes('的委派任务已停止'))).toBe(true);

    // 完成 / 失败仍实时告知正在跑的这一轮，但不当作「你插入了」
    await act(async () => {
      fake.emit('delegate.completed', {
        taskId: 't_done',
        cli: 'claude',
        status: 'done',
        summary: '改好了',
        filesVerified: true,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 40,
        background: true,
      });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(steerCalls.length).toBe(1);
    expect(steerCalls[0]!.text).toContain('改好了');

    const interjects = () =>
      ref.api!.state.messages.flatMap((m) => m.trace ?? []).filter((e) => e.type === 'interject');
    expect(interjects()).toEqual([]);

    // 真用户插话照旧记进轨迹（外显为「你插入了」）
    await act(async () => {
      void (await ref.api!.actions.steerStream('顺便看下测试'));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(interjects().map((e) => (e as { text: string }).text)).toEqual(['顺便看下测试']);

    await act(async () => {
      release?.();
      await turnDone;
    });
  });

  it('后台委派重试耗尽仍失败：空闲时自动唤醒 Nomi 跟进兜底（不插假用户气泡，单轮最多 2 次）', async () => {
    const fake = installFakeApi((name) => {
      if (name === 'harness.state') return { backend: 'nomi', cwd: '/repo', bins: {} };
      return null;
    });
    let round = 0;
    const steerCalls: Array<{ reqId: string; text: string }> = [];
    let holdStream: (() => void) | null = null;
    const client = {
      chat: {
        agentStream: vi.fn(function () {
          const cur = ++round;
          return (async function* () {
            if (holdStream) {
              await new Promise<void>((r) => {
                holdStream = r;
              });
            }
            yield { type: 'delta', content: `Nomi 接手第 ${cur} 次` };
          })();
        }),
        stream: vi.fn(),
        sendMessage: vi.fn(),
        abort: vi.fn(),
        steer: vi.fn((reqId: string, text: string) => {
          steerCalls.push({ reqId, text });
          return Promise.resolve(true);
        }),
      },
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

    // 用户先发了一条需求（挂起流，先测运行中收到后台委派终态经 steer 注入当前轮）
    holdStream = () => {};
    let turnDone: Promise<void> | undefined;
    act(() => {
      turnDone = ref.api!.actions.sendStreamMessage('修一下前端协议');
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    await act(async () => {
      fake.emit('delegate.completed', {
        taskId: 't_live',
        cli: 'claude',
        status: 'error',
        error: 'error_during_execution',
        summary: '',
        filesVerified: false,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 50,
        background: true,
      });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(steerCalls.length).toBe(1);
    expect(steerCalls[0]!.text).toContain('error_during_execution');

    // 放行第一轮结束，进入空闲态
    const release = holdStream;
    holdStream = null;
    await act(async () => {
      release?.();
      await turnDone;
    });
    expect(round).toBe(1);

    // 空闲态连续 3 次收到后台委派最终失败广播：只自动跟进 2 次（防死循环），且不制造假 user 消息
    for (let i = 1; i <= 3; i++) {
      await act(async () => {
        fake.emit('delegate.completed', {
          taskId: `t_${i}`,
          cli: 'claude',
          status: 'error',
          error: 'error_during_execution（已自动重试 5 次仍失败）',
          summary: '',
          filesVerified: false,
          approvals: { asked: 0, denied: 0, timedOut: 0 },
          durationMs: 100,
          background: true,
        });
        await new Promise((r) => setTimeout(r, 25));
      });
    }

    expect(round).toBe(3); // 1 次用户提问 + 最多 2 次自动恢复跟进
    const users = ref.api!.state.messages.filter((m) => m.role === 'user');
    expect(users.map((u) => u.content)).toEqual(['修一下前端协议']);
    expect(
      ref.api!.state.messages.some(
        (m) => m.origin === 'background' && m.content.includes('Nomi 接手第 2 次'),
      ),
    ).toBe(true);
  });
});
