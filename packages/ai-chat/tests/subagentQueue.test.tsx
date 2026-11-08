// @vitest-environment happy-dom
// #281：子任务面板的待发消息按标签分区，切换标签 / 迟到的插话结果都不会把一个标签的消息发给另一个
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SubagentPane,
  useSubagentPane,
  WorkspacePanesProvider,
} from '../src/components/SubagentPane';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { createSubagentQueue } from '../src/contexts/subagentQueue';
import type { HarnessTabMeta, HarnessTabMessage } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const meta = (id: string, status: HarnessTabMeta['status']): HarnessTabMeta => ({
  id,
  title: `Nomi · ${id}`,
  backend: 'claude',
  cwd: '/w',
  cliSessionId: `s-${id}`,
  status,
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  delegation: { by: 'nomi', goal: `goal ${id}`, taskId: `t-${id}` },
});

/** 假内核：每个标签有状态与历史；tabSend 在跑时拒绝，否则写进历史、进入运行，finish() 结束这一轮 */
function backend(initial: Record<string, HarnessTabMeta['status']>) {
  const status = { ...initial };
  const history: Record<string, HarnessTabMessage[]> = Object.fromEntries(
    Object.keys(initial).map((id) => [id, []]),
  );
  const turns: Record<string, () => void> = {};
  let steer: (input: { id: string; text: string }) => unknown = () => false;
  let n = 0;
  const snapshot = () => ({
    tabs: Object.entries(status).map(([id, s]) => ({ ...meta(id, s), updatedAt: ++n })),
    activeTabId: 'main',
    running: 0,
    queued: 0,
  });
  const push = () => fake.publish('harness.tabsChanged', snapshot());
  const fake: FakeApi = installFakeApi({
    'harness.tabs': () => snapshot(),
    'harness.tabMessages': ({ id }: { id: string }) => [...(history[id] ?? [])],
    'harness.tabSteer': (input: { id: string; text: string }) => steer(input),
    'harness.tabCancel': () => true,
    'harness.modelCatalog': () => ({ backend: 'claude', defaultModel: null, models: [] }),
    'harness.tabSend': ({ id, prompt }: { id: string; prompt: string }) => {
      if (status[id] === 'running') throw new Error('previous turn still running');
      history[id]!.push({ id: `u${++n}`, role: 'user', content: prompt, timestamp: Date.now() });
      status[id] = 'running';
      push();
      return new Promise((resolve) => {
        turns[id] = () => {
          history[id]!.push({ id: `a${++n}`, role: 'assistant', content: 'ok', timestamp: 1 });
          status[id] = 'idle';
          push();
          resolve({ text: 'ok', sessionId: null });
        };
      });
    },
  });
  return {
    fake,
    history,
    sends: () => fake.inputs('harness.tabSend') as { id: string; prompt: string }[],
    setSteer: (fn: typeof steer) => {
      steer = fn;
    },
    /** 这个标签的这一轮结束（没有经 tabSend 开始的也行：委派自己跑的那一轮） */
    finish: async (id: string) => {
      await act(async () => {
        if (turns[id]) {
          const done = turns[id]!;
          delete turns[id];
          done();
        } else {
          status[id] = 'idle';
          push();
        }
        await fake.settle();
      });
    },
  };
}

const Switch: React.FC = () => {
  const pane = useSubagentPane();
  return (
    <>
      <button type="button" data-testid="open-a" onClick={() => pane?.openSubagent('a')} />
      <button type="button" data-testid="open-b" onClick={() => pane?.openSubagent('b')} />
      <button type="button" data-testid="close-pane" onClick={() => pane?.closeSubagent()} />
    </>
  );
};

const mount = () =>
  render(
    <HarnessTabsProvider>
      <WorkspacePanesProvider>
        <Switch />
        <SubagentPane />
      </WorkspacePanesProvider>
    </HarnessTabsProvider>,
  );

async function open(id: 'a' | 'b') {
  fireEvent.click(screen.getByTestId(`open-${id}`));
  await waitFor(() =>
    expect(screen.getByTestId('subagent-pane').textContent).toContain(`goal ${id}`),
  );
}

async function type(text: string) {
  fireEvent.change(screen.getByTestId('subagent-input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('subagent-send'));
  await act(async () => {
    await Promise.resolve();
  });
}

const queuedTexts = () => screen.queryAllByTestId('conv-queued').map((el) => el.textContent ?? '');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('SubagentPane queue is per tab (#281)', () => {
  it('A running without steer: queued text stays with A after opening idle B', async () => {
    const be = backend({ a: 'running', b: 'idle' });
    mount();
    await open('a');
    await type('给 A 的补充');
    await waitFor(() => expect(queuedTexts().join()).toContain('给 A 的补充'));

    await open('b');
    await be.fake.settle();
    expect(queuedTexts()).toEqual([]);
    expect(be.sends()).toEqual([]);
    expect(be.history.b).toEqual([]);

    // A 这一轮结束：只发给 A
    await be.finish('a');
    await waitFor(() => expect(be.sends()).toEqual([{ id: 'a', prompt: '给 A 的补充' }]));
    expect(be.history.b).toEqual([]);
  });

  it('late steer(A) false after switching to B goes back to A, not B', async () => {
    const be = backend({ a: 'running', b: 'idle' });
    let resolveSteer!: (ok: boolean) => void;
    be.setSteer(() => new Promise<boolean>((r) => (resolveSteer = r)));
    mount();
    await open('a');
    await type('插话 A');
    await waitFor(() => expect(be.fake.inputs('harness.tabSteer')).toHaveLength(1));
    await open('b');
    await act(async () => {
      resolveSteer(false);
      await be.fake.settle();
    });
    expect(queuedTexts()).toEqual([]);
    expect(be.sends()).toEqual([]);

    await open('a');
    expect(queuedTexts().join()).toContain('插话 A');
    await be.finish('a');
    await waitFor(() => expect(be.sends()).toEqual([{ id: 'a', prompt: '插话 A' }]));
    expect(be.history.b).toEqual([]);
  });

  it('late steer(A) true after switching to B is not sent again', async () => {
    const be = backend({ a: 'running', b: 'idle' });
    let resolveSteer!: (ok: boolean) => void;
    be.setSteer(() => new Promise<boolean>((r) => (resolveSteer = r)));
    mount();
    await open('a');
    await type('插话 A');
    await waitFor(() => expect(be.fake.inputs('harness.tabSteer')).toHaveLength(1));
    await open('b');
    await act(async () => {
      resolveSteer(true);
      await be.fake.settle();
    });
    await be.finish('a');
    await open('a');
    await be.fake.settle();
    expect(queuedTexts()).toEqual([]);
    expect(be.sends()).toEqual([]);
  });

  it('A → B → A keeps A its own draft and queue', async () => {
    const be = backend({ a: 'running', b: 'idle' });
    mount();
    await open('a');
    await type('A 排队');
    fireEvent.change(screen.getByTestId('subagent-input'), { target: { value: 'A 草稿' } });

    await open('b');
    expect((screen.getByTestId('subagent-input') as HTMLTextAreaElement).value).toBe('');
    expect(queuedTexts()).toEqual([]);

    // 关掉面板也不丢
    fireEvent.click(screen.getByTestId('close-pane'));
    await open('a');
    expect((screen.getByTestId('subagent-input') as HTMLTextAreaElement).value).toBe('A 草稿');
    expect(queuedTexts().join()).toContain('A 排队');
    expect(be.sends()).toEqual([]);
  });

  it('several queued items go out to A in order, once each, while the pane shows B', async () => {
    const be = backend({ a: 'running', b: 'idle' });
    mount();
    await open('a');
    await type('一');
    await type('二');
    await type('三');
    await waitFor(() => expect(queuedTexts()).toHaveLength(3));
    // 面板切走，排队照样按 A 的节奏发
    await open('b');

    await be.finish('a');
    await waitFor(() => expect(be.sends().map((s) => s.prompt)).toEqual(['一']));
    await be.finish('a');
    await waitFor(() => expect(be.sends().map((s) => s.prompt)).toEqual(['一', '二']));
    await be.finish('a');
    await waitFor(() => expect(be.sends().map((s) => s.prompt)).toEqual(['一', '二', '三']));
    await be.finish('a');
    await be.fake.settle();

    expect(be.sends().every((s) => s.id === 'a')).toBe(true);
    expect(be.history.a!.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      '一',
      '二',
      '三',
    ]);
    expect(be.history.b).toEqual([]);
  });
});

describe('createSubagentQueue', () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('while an earlier message is still undelivered, a later one queues behind it instead of steering ahead', async () => {
    const steered: string[] = [];
    const sent: string[] = [];
    const first = deferred();
    const q = createSubagentQueue({
      send: async (_id, text) => {
        sent.push(text);
      },
      steer: async (_id, text) => {
        steered.push(text);
        if (text === 'one') {
          await first.promise;
          return false;
        }
        return true;
      },
      accepted: async () => false,
    });
    q.sync([{ id: 'A', status: 'running' }]);
    q.setDraft('A', 'one');
    const p1 = q.submit('A');
    q.setDraft('A', 'two');
    await q.submit('A');
    expect(steered).toEqual(['one']);
    first.resolve();
    await p1;
    expect(q.view('A').queued).toEqual(['one', 'two']);
    q.sync([{ id: 'A', status: 'idle' }]);
    await flush();
    await flush();
    expect(sent).toEqual(['one', 'two']);
  });

  it('a rejected send that never reached the tab stays at the head and is retried later', async () => {
    const turns: ReturnType<typeof deferred>[] = [];
    const send = vi.fn(() => {
      const d = deferred();
      turns.push(d);
      return d.promise;
    });
    const q = createSubagentQueue({
      send,
      steer: async () => false,
      accepted: async () => false,
    });
    q.sync([{ id: 'a', status: 'running' }]);
    for (const text of ['一', '二']) {
      q.setDraft('a', text);
      await q.submit('a');
    }
    q.sync([{ id: 'a', status: 'idle' }]);
    expect(send).toHaveBeenCalledTimes(1);
    turns[0]!.reject(new Error('busy'));
    await flush();
    // 留在队首、暂停，不自动重试，也不跳过它发第二条
    expect(q.view('a').queued).toEqual(['一', '二']);
    expect(q.view('a').error).toBe('busy');
    expect(send).toHaveBeenCalledTimes(1);

    // 这个标签跑完一轮：按顺序接着发
    q.sync([{ id: 'a', status: 'running' }]);
    q.sync([{ id: 'a', status: 'idle' }]);
    expect(send).toHaveBeenLastCalledWith('a', '一');
    turns[1]!.resolve();
    await flush();
    expect(send).toHaveBeenLastCalledWith('a', '二');
    turns[2]!.resolve();
    await flush();
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['一', '一', '二']);
    expect(q.view('a').queued).toEqual([]);
  });

  it('a send that the tab accepted and then failed is not resent', async () => {
    const d = deferred();
    const send = vi.fn(() => d.promise);
    const q = createSubagentQueue({ send, steer: async () => false, accepted: async () => true });
    q.sync([{ id: 'a', status: 'idle' }]);
    q.setDraft('a', '一');
    await q.submit('a');
    d.reject(new Error('turn failed'));
    await flush();
    expect(q.view('a').queued).toEqual([]);
    q.sync([{ id: 'a', status: 'idle' }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('closing a tab drops its queue; results that arrive later do not touch a new tab with that id', async () => {
    let resolveSteer!: (ok: boolean) => void;
    const send = vi.fn(async () => undefined);
    const q = createSubagentQueue({
      send,
      steer: () => new Promise<boolean>((r) => (resolveSteer = r)),
      accepted: async () => false,
    });
    q.sync([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'idle' },
    ]);
    q.setDraft('a', '给 A');
    const pending = q.submit('a');
    q.sync([{ id: 'b', status: 'idle' }]);
    q.sync([
      { id: 'a', status: 'idle' },
      { id: 'b', status: 'idle' },
    ]);
    resolveSteer(false);
    await pending;
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(q.view('a').queued).toEqual([]);
    expect(q.view('b').queued).toEqual([]);
  });
});
