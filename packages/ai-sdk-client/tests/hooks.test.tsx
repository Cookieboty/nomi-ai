/**
 * React hooks 端到端测试：AIProvider + useChat / useAgent / useAIEvents / useTTSLipSync / useUserProfile。
 *
 * - happy-dom 提供 DOM；`testing-library/react` 触发 render & unmount；
 * - 依赖 FakeBridge 完全 in-process 模拟 IPC。
 */

import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AI_EVENT_CHANNEL, IPC_METHODS, channelName, chunkChannelName } from '../src/channels';
import { AIProvider } from '../src/react/AIProvider';
import { useAgent } from '../src/react/useAgent';
import { useAIEvents } from '../src/react/useAIEvents';
import { useChat } from '../src/react/useChat';
import { useTTSLipSync } from '../src/react/useTTSLipSync';
import { useUserProfile } from '../src/react/useUserProfile';

import { FakeBridge } from './FakeBridge';

function wrapperFactory(bridge: FakeBridge) {
  const Wrapper = ({ children }: PropsWithChildren) => (
    <AIProvider bridge={bridge}>{children}</AIProvider>
  );
  Wrapper.displayName = 'TestAIProviderWrapper';
  return Wrapper;
}

describe('useAIEvents', () => {
  it('订阅事件，unmount 后停止接收', () => {
    const bridge = new FakeBridge();
    const seen: unknown[] = [];
    const wrapper = wrapperFactory(bridge);
    const { unmount } = renderHook(() => useAIEvents('tts:end', (p) => seen.push(p)), { wrapper });
    act(() => bridge.emit(AI_EVENT_CHANNEL, { evt: 'tts:end', data: { reqId: 'r1' } }));
    expect(seen).toEqual([{ reqId: 'r1' }]);
    unmount();
    act(() => bridge.emit(AI_EVENT_CHANNEL, { evt: 'tts:end', data: { reqId: 'r2' } }));
    expect(seen).toHaveLength(1);
  });
});

describe('useChat', () => {
  it('send 触发 stream 并累积 deltaText 到 assistant 消息', async () => {
    const bridge = new FakeBridge();
    const spec = IPC_METHODS.find((s) => s.facade === 'chat' && s.method === 'stream')!;
    const chunkCh = chunkChannelName(spec);
    bridge.handle(channelName(spec), async (opts) => {
      const reqId = (opts as { reqId?: string }).reqId!;
      queueMicrotask(() => {
        bridge.emit(chunkCh, { reqId, done: false, value: { deltaText: 'hi ' } });
        bridge.emit(chunkCh, { reqId, done: false, value: { deltaText: 'nya!' } });
        bridge.emit(chunkCh, { reqId, done: true });
      });
      return { ok: true, reqId };
    });

    const wrapper = wrapperFactory(bridge);
    const { result } = renderHook(() => useChat(), { wrapper });
    await act(async () => {
      await result.current.send('你好');
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
    const [userMsg, assistantMsg] = result.current.messages;
    expect(userMsg?.role).toBe('user');
    expect(userMsg?.content).toBe('你好');
    expect(assistantMsg?.role).toBe('assistant');
    expect(assistantMsg?.content).toBe('hi nya!');
  });
});

describe('useChat · 真实 ChatChunk 契约（#51）', () => {
  const setup = (chunks: unknown[]) => {
    const bridge = new FakeBridge();
    const spec = IPC_METHODS.find((s) => s.facade === 'chat' && s.method === 'stream')!;
    const chunkCh = chunkChannelName(spec);
    bridge.handle(channelName(spec), async (opts) => {
      const reqId = (opts as { reqId?: string }).reqId!;
      queueMicrotask(() => {
        for (const value of chunks) bridge.emit(chunkCh, { reqId, done: false, value });
        bridge.emit(chunkCh, { reqId, done: true });
      });
      return { ok: true, reqId };
    });
    return renderHook(() => useChat(), { wrapper: wrapperFactory(bridge) });
  };

  it('{type:"delta", content} 累积成助手文本；usage / done / reasoning 不进正文', async () => {
    const { result } = setup([
      { type: 'reasoning', content: '想一想' },
      { type: 'delta', content: '你好，' },
      { type: 'delta', content: '世界' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'done', finishReason: 'stop' },
    ]);
    await act(async () => {
      await result.current.send('hi');
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.messages[1]?.content).toBe('你好，世界');
    expect(result.current.error).toBeUndefined();
  });

  it('{type:"error"} chunk 显式变成 error，而不是静默空白', async () => {
    const { result } = setup([
      { type: 'delta', content: 'a' },
      { type: 'error', error: '炸了' },
    ]);
    await act(async () => {
      await result.current.send('hi');
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.error?.message).toContain('炸了');
  });
});

describe('useAgent', () => {
  it('agent:step 更新 lastStep，tool:confirm-required 加入队列', async () => {
    const bridge = new FakeBridge();
    bridge.handle('ai:tools:confirm', () => undefined);
    const wrapper = wrapperFactory(bridge);
    const { result } = renderHook(() => useAgent(), { wrapper });

    act(() =>
      bridge.emit(AI_EVENT_CHANNEL, {
        evt: 'agent:step',
        data: { sessionId: 's', step: 3, reason: 'llm-call' },
      }),
    );
    await waitFor(() => {
      expect(result.current.lastStep?.step).toBe(3);
    });

    act(() =>
      bridge.emit(AI_EVENT_CHANNEL, {
        evt: 'tool:confirm-required',
        data: {
          reqId: 'c1',
          toolName: 'fs.write',
          argumentsJson: '{}',
          createdAt: 1,
        },
      }),
    );
    await waitFor(() => {
      expect(result.current.pendingConfirms).toHaveLength(1);
    });

    await act(async () => result.current.confirm('c1', true));
    expect(result.current.pendingConfirms).toHaveLength(0);
    expect(bridge.invokeLog.find((l) => l.channel === 'ai:tools:confirm')).toBeTruthy();
  });
});

describe('useTTSLipSync', () => {
  it('每次 tts:chunk 更新 rms，tts:end 归零', async () => {
    const bridge = new FakeBridge();
    const wrapper = wrapperFactory(bridge);
    const { result } = renderHook(() => useTTSLipSync({ minIntervalMs: 0 }), {
      wrapper,
    });
    act(() =>
      bridge.emit(AI_EVENT_CHANNEL, {
        evt: 'tts:chunk',
        data: { reqId: 'r', rms: 0.8 },
      }),
    );
    await waitFor(() => expect(result.current).toBe(0.8));

    act(() =>
      bridge.emit(AI_EVENT_CHANNEL, {
        evt: 'tts:end',
        data: { reqId: 'r' },
      }),
    );
    await waitFor(() => expect(result.current).toBe(0));
  });
});

describe('useUserProfile', () => {
  it('挂载时拉取 profile，subscribe 后收到更新', async () => {
    const bridge = new FakeBridge();
    bridge.handle('ai:userProfile:get', () => ({ id: 'u1', nickname: 'nya' }));
    bridge.handle('ai:userProfile:set', (patch) => ({
      id: 'u1',
      nickname: 'nya',
      ...(patch as object),
    }));
    const wrapper = wrapperFactory(bridge);
    const { result } = renderHook(() => useUserProfile<{ id: string; nickname: string }>(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.profile).toEqual({ id: 'u1', nickname: 'nya' }));

    // 事件推送应触发更新
    act(() =>
      bridge.emit(AI_EVENT_CHANNEL, {
        evt: 'userProfile:changed',
        data: { profile: { id: 'u1', nickname: 'senpai' } },
      }),
    );
    await waitFor(() => expect(result.current.profile?.nickname).toBe('senpai'));

    // set 也应更新
    await act(async () => {
      await result.current.set({ nickname: 'ai' });
    });
    expect(result.current.profile?.nickname).toBe('ai');
  });
});

describe('AIProvider', () => {
  it('unmount 时会 dispose 自建 client', async () => {
    const bridge = new FakeBridge();
    const disposeSpy = vi.fn();
    // 用一个占位组件确保 Provider 卸载路径被走
    const Placeholder = () => null;
    const { unmount } = render(
      <AIProvider bridge={bridge}>
        <Placeholder />
      </AIProvider>,
    );
    // 无法直接监听 dispose；用 listeners size 侧证：先加事件订阅，
    // 卸载后再 emit 不再触发（即 ai:event 侧的监听已被 dispose 清空）。
    bridge.emit(AI_EVENT_CHANNEL, { evt: 'agent:step', data: {} });
    const hit = bridge.listeners.get(AI_EVENT_CHANNEL)?.size ?? 0;
    expect(hit).toBeGreaterThan(0);
    unmount();
    expect(disposeSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(bridge.listeners.get(AI_EVENT_CHANNEL)?.size ?? 0).toBe(0);
    });
  });
});

describe('AIProvider · StrictMode', () => {
  it('StrictMode 双挂载不会 dispose 仍在使用的 client；真正卸载后才 dispose', async () => {
    const { StrictMode } = await import('react');
    const { useAIClient } = await import('../src/react/AIProvider');
    const bridge = new FakeBridge();
    let seen: { disposed?: boolean } | undefined;
    const Probe = () => {
      seen = useAIClient() as unknown as { disposed?: boolean };
      return null;
    };
    const { unmount } = render(
      <StrictMode>
        <AIProvider bridge={bridge}>
          <Probe />
        </AIProvider>
      </StrictMode>,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.disposed).toBe(false);
    unmount();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.disposed).toBe(true);
  });
});
