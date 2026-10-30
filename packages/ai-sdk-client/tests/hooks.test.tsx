/**
 * React hooks 端到端测试：AIProvider + useChat / useAgent / useAIEvents / useTTSLipSync / useUserProfile。
 *
 * - happy-dom 提供 DOM；`testing-library/react` 触发 render & unmount；
 * - 内核侧是用应用契约实现的假门面（tests/fakeServer.ts），经 in-process 传输连接。
 */

import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it } from 'vitest';

import { AIProvider } from '../src/react/AIProvider';
import { useAgent } from '../src/react/useAgent';
import { useAIEvents } from '../src/react/useAIEvents';
import { useChat } from '../src/react/useChat';
import { useTTSLipSync } from '../src/react/useTTSLipSync';
import { useUserProfile } from '../src/react/useUserProfile';

import { createFakeServer, flush, makeProfile, type FakeServer } from './fakeServer';

function wrapperFactory(server: FakeServer) {
  const transport = server.connect();
  const Wrapper = ({ children }: PropsWithChildren) => (
    <AIProvider transport={transport}>{children}</AIProvider>
  );
  Wrapper.displayName = 'TestAIProviderWrapper';
  return Wrapper;
}

describe('useAIEvents', () => {
  it('订阅事件，unmount 后停止接收', async () => {
    const server = createFakeServer();
    const seen: unknown[] = [];
    const wrapper = wrapperFactory(server);
    const { unmount } = renderHook(() => useAIEvents('tts:end', (p) => seen.push(p)), { wrapper });
    await act(() => flush());
    await act(async () => {
      server.publish('ai.tts.end', { reqId: 'r1' });
      await flush();
    });
    expect(seen).toEqual([{ reqId: 'r1' }]);
    unmount();
    await flush();
    server.publish('ai.tts.end', { reqId: 'r2' });
    await flush();
    expect(seen).toHaveLength(1);
  });
});

describe('useChat', () => {
  const setup = (chunks: unknown[]) => {
    const server = createFakeServer({
      'ai.chat.stream': async function* () {
        for (const c of chunks) yield c;
      },
    });
    return renderHook(() => useChat(), { wrapper: wrapperFactory(server) });
  };

  it('send 触发 stream 并累积助手文本', async () => {
    const { result } = setup([
      { type: 'delta', content: 'hi ' },
      { type: 'delta', content: 'nya!' },
    ]);
    await act(async () => {
      await result.current.send('你好');
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));
    const [userMsg, assistantMsg] = result.current.messages;
    expect(userMsg?.role).toBe('user');
    expect(userMsg?.content).toBe('你好');
    expect(assistantMsg?.role).toBe('assistant');
    expect(assistantMsg?.content).toBe('hi nya!');
  });

  it('{type:"delta", content} 累积成助手文本；usage / done / reasoning 不进正文', async () => {
    const { result } = setup([
      { type: 'reasoning', content: '想一想' },
      { type: 'delta', content: '你好，' },
      { type: 'delta', content: '世界' },
      { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
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
    const server = createFakeServer({ 'ai.tools.confirm': () => undefined });
    const wrapper = wrapperFactory(server);
    const { result } = renderHook(() => useAgent(), { wrapper });
    await act(() => flush());

    act(() => server.publish('ai.agent.step', { sessionId: 's', step: 3, reason: 'llm-call' }));
    await waitFor(() => expect(result.current.lastStep?.step).toBe(3));

    act(() =>
      server.publish('ai.tool.confirmRequired', {
        reqId: 'c1',
        toolName: 'fs.write',
        argumentsJson: '{}',
        createdAt: 1,
      }),
    );
    await waitFor(() => expect(result.current.pendingConfirms).toHaveLength(1));

    await act(async () => result.current.confirm('c1', true));
    expect(result.current.pendingConfirms).toHaveLength(0);
    expect(server.calls.find((c) => c.name === 'ai.tools.confirm')?.input).toEqual({
      reqId: 'c1',
      ok: true,
    });
  });
});

describe('useTTSLipSync', () => {
  it('每次 tts:chunk 更新 rms，tts:end 归零', async () => {
    const server = createFakeServer();
    const wrapper = wrapperFactory(server);
    const { result } = renderHook(() => useTTSLipSync({ minIntervalMs: 0 }), { wrapper });
    await act(() => flush());
    act(() => server.publish('ai.tts.chunk', { reqId: 'r', rms: 0.8 }));
    await waitFor(() => expect(result.current).toBe(0.8));
    act(() => server.publish('ai.tts.end', { reqId: 'r' }));
    await waitFor(() => expect(result.current).toBe(0));
  });
});

describe('useUserProfile', () => {
  it('挂载时拉取 profile，subscribe 后收到更新', async () => {
    const setInputs: unknown[] = [];
    const server = createFakeServer({
      'ai.memory.userProfile.get': () => makeProfile({ nickname: 'nya' }),
      'ai.memory.userProfile.set': (input) => {
        setInputs.push(input);
        return makeProfile({ nickname: (input as { patch: { nickname: string } }).patch.nickname });
      },
    });
    const wrapper = wrapperFactory(server);
    const { result } = renderHook(() => useUserProfile<{ nickname: string }>(), { wrapper });
    await waitFor(() => expect(result.current.profile?.nickname).toBe('nya'));

    // 事件推送应触发更新
    act(() =>
      server.publish('ai.userProfile.changed', { profile: makeProfile({ nickname: 'senpai' }) }),
    );
    await waitFor(() => expect(result.current.profile?.nickname).toBe('senpai'));

    // set 收裸补丁，包成 ProfilePatch（{ patch, source: 'user' }）再发，也应更新
    await act(async () => {
      await result.current.set({ nickname: 'ai' });
    });
    expect(setInputs).toEqual([{ patch: { nickname: 'ai' }, source: 'user' }]);
    expect(result.current.profile?.nickname).toBe('ai');

    await act(async () => {
      await result.current.set({ nickname: 'x' }, { reason: 'settings' });
    });
    expect(setInputs[1]).toEqual({ patch: { nickname: 'x' }, source: 'user', reason: 'settings' });
  });
});

describe('AIProvider', () => {
  it('unmount 时会 dispose 自建 client（连接随之关闭）', async () => {
    const server = createFakeServer({ 'ai.sessions.list': () => [] });
    const transport = server.connect();
    let seen = 0;
    const Probe = () => {
      useAIEvents('agent:step', () => {
        seen += 1;
      });
      return null;
    };
    const { unmount } = render(
      <AIProvider transport={transport}>
        <Probe />
      </AIProvider>,
    );
    await act(() => flush());
    await act(async () => {
      server.publish('ai.agent.step', {});
      await flush();
    });
    expect(seen).toBe(1);
    unmount();
    await flush(10);
    server.publish('ai.agent.step', {});
    await flush();
    expect(seen).toBe(1);
  });
});

describe('AIProvider · StrictMode', () => {
  it('StrictMode 双挂载不会 dispose 仍在使用的 client；真正卸载后才 dispose', async () => {
    const { StrictMode } = await import('react');
    const { useAIClient } = await import('../src/react/AIProvider');
    const server = createFakeServer();
    const transport = server.connect();
    let seen: { disposed?: boolean } | undefined;
    const Probe = () => {
      seen = useAIClient() as unknown as { disposed?: boolean };
      return null;
    };
    const { unmount } = render(
      <StrictMode>
        <AIProvider transport={transport}>
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
