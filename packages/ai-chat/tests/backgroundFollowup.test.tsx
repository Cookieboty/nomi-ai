// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useToast } from '../src/app/AppOverlays';
import { AssistantMessage } from '../src/components/Conversation/Messages';
import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import {
  DELEGATE_NOTICE_DURATION_MS,
  DELEGATE_NOTICE_EVENT,
  emitDelegateNotice,
  type DelegateNoticeDetail,
} from '../src/services/delegateNotice';
import { buildProviderMessages } from '../src/services/history';
import type { ChatMessage } from '../src/types/chat';
import {
  fromHarnessMessage,
  nomiConvMessages,
  nomiLive,
  settledNomiMessages,
} from '../src/utils/convAdapters';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

// 后台子代理完成后 CLI 自发的一轮 / 异步委派完成跟进（docs/development/coding-agents.md）
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

  it('运行中收到被停止的委派：不注入、不留会话消息且仅发轻提示；完成才静默告知模型', async () => {
    const fake = installFakeApi(() => null);
    const steerCalls: Array<{ reqId: string; text: string }> = [];
    const notices: DelegateNoticeDetail[] = [];
    const onNotice = (e: Event) => {
      notices.push((e as CustomEvent<DelegateNoticeDetail>).detail);
    };
    window.addEventListener(DELEGATE_NOTICE_EVENT, onNotice);
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
    try {
      render(
        <AiChatContextProvider client={client}>
          <Probe />
        </AiChatContextProvider>,
      );
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      const save = vi.spyOn(ref.api!.state.ipcClient, 'saveMessage');

      let turnDone: Promise<void> | undefined;
      act(() => {
        turnDone = ref.api!.actions.sendStreamMessage('review 当前项目');
      });
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
      const saveCallsBeforeStop = save.mock.calls.length;

      // 用户在运行中把 CLI 停下：不再写进会话，也不再 steer，仅弹短暂轻提示
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
      expect(ref.api!.state.messages.some((m) => m.content.includes('的委派任务已停止'))).toBe(
        false,
      );
      expect(save.mock.calls.length).toBe(saveCallsBeforeStop);
      expect(notices).toEqual([{ kind: 'stopped', agentName: 'Claude Code', cancelledBy: 'user' }]);

      // 完成仍静默告知正在跑的这一轮（不堆积可见消息气泡），并发轻提示
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
      expect(ref.api!.state.messages.some((m) => m.id.startsWith('delegate-t_done'))).toBe(false);
      expect(notices.at(-1)).toEqual({ kind: 'done', agentName: 'Claude Code' });
      expect(nomiLive(ref.api!.state.messages, true)).toBeDefined();

      // 带产出图片的委派结果和主标签背景跟进：插在当前流式用户消息之前，不打断正在流式的占位
      await act(async () => {
        fake.emit('delegate.completed', {
          taskId: 't_done_img',
          cli: 'claude',
          status: 'done',
          summary: '图生成好了',
          images: ['chat-asset://images/a.png'],
          filesVerified: false,
          approvals: { asked: 0, denied: 0, timedOut: 0 },
          durationMs: 45,
          background: true,
        });
        fake.emit('harness.tabMessage', {
          tabId: 'main',
          message: {
            id: 'f_live',
            role: 'assistant',
            content: 'MAIN_BG',
            timestamp: 99,
            origin: 'background',
          },
        });
        await new Promise((r) => setTimeout(r, 20));
      });
      const settled = settledNomiMessages(ref.api!.state.messages, true);
      expect(settled.map((m) => m.id).slice(-2)).toContain('f_live');
      expect(settled.at(-1)?.role).toBe('user');
      expect(settled.at(-1)?.content).toBe('review 当前项目');
      expect(nomiLive(ref.api!.state.messages, true)).toBeDefined();

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
    } finally {
      window.removeEventListener(DELEGATE_NOTICE_EVENT, onNotice);
    }
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
    expect(ref.api!.state.messages.some((m) => m.id.startsWith('delegate-t_live'))).toBe(false);

    // 放行第一轮结束，进入空闲态
    const release = holdStream;
    holdStream = null;
    await act(async () => {
      release?.();
      await turnDone;
    });
    expect(round).toBe(1);

    // 空闲态连续 3 次收到后台委派最终失败广播：只自动跟进 2 次（防死循环），前 2 次隐藏不堆气泡
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
    const visibleDelegateErrors = nomiConvMessages(ref.api!.state.messages).filter((m) =>
      m.id.startsWith('delegate-t_'),
    );
    expect(visibleDelegateErrors.map((m) => m.id)).toEqual(['delegate-t_3-100']);
  });

  it('连续停止多个委派任务时通过 Toast 短暂聚合展示，3.2 秒后自动消失', () => {
    vi.useFakeTimers();
    try {
      let currentToast: string | null = null;
      const Probe = () => {
        const [toast] = useToast();
        currentToast = toast;
        return null;
      };
      render(<Probe />);
      expect(currentToast).toBeNull();

      act(() => {
        emitDelegateNotice({ kind: 'stopped', agentName: 'Claude Code', cancelledBy: 'user' });
      });
      expect(currentToast).toBe('Claude Code 的委派任务已停止');

      act(() => {
        emitDelegateNotice({ kind: 'stopped', agentName: 'Claude Code', cancelledBy: 'user' });
        emitDelegateNotice({ kind: 'stopped', agentName: 'Claude Code', cancelledBy: 'user' });
        emitDelegateNotice({ kind: 'stopped', agentName: 'Claude Code', cancelledBy: 'user' });
      });
      expect(currentToast).toBe('4 个委派任务已停止');

      act(() => {
        vi.advanceTimersByTime(DELEGATE_NOTICE_DURATION_MS - 1);
      });
      expect(currentToast).toBe('4 个委派任务已停止');

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(currentToast).toBeNull();

      // 清空后再次触发从单条重新计数
      act(() => {
        emitDelegateNotice({ kind: 'stopped', agentName: 'Codex', cancelledBy: 'nomi' });
      });
      expect(currentToast).toBe('Codex 的委派任务已随这一轮一起停止');
    } finally {
      vi.useRealTimers();
    }
  });

  it('空闲态且已有原位 DelegateCard 时：写入静默上下文供下一轮使用，不在会话流渲染气泡', async () => {
    const fake = installFakeApi(() => null);
    const notices: DelegateNoticeDetail[] = [];
    const onNotice = (e: Event) => {
      notices.push((e as CustomEvent<DelegateNoticeDetail>).detail);
    };
    window.addEventListener(DELEGATE_NOTICE_EVENT, onNotice);
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
    try {
      render(
        <AiChatContextProvider client={client}>
          <Probe />
        </AiChatContextProvider>,
      );
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));

      const cardTurn: ChatMessage = {
        id: 'm_card',
        role: 'assistant',
        content: '已派给子代理处理。',
        timestamp: 10,
        trace: [
          {
            type: 'tool',
            id: 'call_1',
            name: 'delegate_to_cli',
            status: 'done',
            output: JSON.stringify({ ok: true, data: { taskId: 't_card', status: 'running' } }),
          },
        ],
      };
      act(() => {
        ref.api!.dispatch({ type: 'SET_MESSAGES', payload: [cardTurn] });
      });

      await act(async () => {
        fake.emit('delegate.completed', {
          taskId: 't_card',
          cli: 'claude',
          status: 'done',
          summary: '改好了卡片任务',
          filesVerified: true,
          approvals: { asked: 0, denied: 0, timedOut: 0 },
          durationMs: 50,
          background: true,
        });
        await new Promise((r) => setTimeout(r, 20));
      });

      const raw = ref.api!.state.messages.find((m) => m.id === 'delegate-t_card-50');
      expect(raw?.hidden).toBe(true);
      expect(nomiConvMessages(ref.api!.state.messages).some((m) => m.id === raw?.id)).toBe(false);
      const providerMsgs = buildProviderMessages(ref.api!.state.messages, '继续');
      expect(
        providerMsgs.some(
          (m) => m.content.includes('<cli-output>') && m.content.includes('改好了卡片任务'),
        ),
      ).toBe(true);
      expect(notices).toEqual([{ kind: 'done', agentName: 'Claude Code' }]);
    } finally {
      window.removeEventListener(DELEGATE_NOTICE_EVENT, onNotice);
    }
  });

  it('无 DelegateCard（/agent）、followUp 续聊或带生成图片时，结果仍可见保留；同步委派不重复写入', async () => {
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

    const cardMsg = (taskId: string): ChatMessage => ({
      id: `call_${taskId}`,
      role: 'assistant',
      content: '已派出',
      timestamp: 10,
      trace: [
        {
          type: 'tool',
          id: `tc_${taskId}`,
          name: 'delegate_to_cli',
          status: 'done',
          output: JSON.stringify({ ok: true, data: { taskId, status: 'running' } }),
        },
      ],
    });
    act(() => {
      ref.api!.dispatch({
        type: 'SET_MESSAGES',
        payload: [cardMsg('t_card2'), cardMsg('t_card3')],
      });
    });

    await act(async () => {
      // 1. 无卡片（/agent）→ 可见
      fake.emit('delegate.completed', {
        taskId: 't_slash',
        cli: 'codex',
        status: 'done',
        summary: 'slash 完成',
        filesVerified: true,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 11,
        background: true,
      });
      // 2. 有卡片但是 followUp 续聊 → 可见
      fake.emit('delegate.completed', {
        taskId: 't_card2',
        cli: 'claude',
        status: 'done',
        summary: '续聊回复',
        filesVerified: true,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 12,
        background: true,
        followUp: true,
      });
      // 3. 有卡片但产出图片 → 可见
      fake.emit('delegate.completed', {
        taskId: 't_card3',
        cli: 'nomi',
        status: 'done',
        summary: '',
        images: ['chat-asset://images/out.png'],
        filesVerified: false,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 13,
        background: true,
      });
      // 4. 同步委派（无 background 且无 followUp）→ 不写后台跟进消息
      fake.emit('delegate.completed', {
        taskId: 't_sync',
        cli: 'claude',
        status: 'done',
        summary: '同步完成',
        filesVerified: true,
        approvals: { asked: 0, denied: 0, timedOut: 0 },
        durationMs: 14,
      });
      await new Promise((r) => setTimeout(r, 20));
    });

    const visibleIds = nomiConvMessages(ref.api!.state.messages).map((m) => m.id);
    expect(visibleIds).toContain('delegate-t_slash-11');
    expect(visibleIds.some((id) => id.startsWith('delegate-t_card2-f'))).toBe(true);
    expect(visibleIds).toContain('delegate-t_card3-13');
    expect(ref.api!.state.messages.some((m) => m.id.startsWith('delegate-t_sync'))).toBe(false);
  });
});
