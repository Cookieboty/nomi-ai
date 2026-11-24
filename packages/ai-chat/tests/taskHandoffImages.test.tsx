// @vitest-environment happy-dom
/**
 * 前台 Nomi 长程对话「转后台」（#413 / #414 前端接线）：
 * - 本轮已获准发送的原图随接管一起交给后台（tasks.handoffFromChat.images），不是只留在前台气泡里；
 * - 只有后台真的接管了（返回 task.id）才中止前台这一轮；
 * - 存储失败 / 图片不可用 / 没有任何返回：保留前台已输出的内容，给出明确提示，流不停；
 * - 同一轮重复点击只接管一次。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { ContractError } from '@nomi-ai/contract';
import { t } from '@nomi-ai/ui';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiChatContextProvider, useAiChat } from '../src/contexts/AiChatContext';
import { selectStreamingHere } from '../src/contexts/aiChatStore';
import type { ImageAttachment } from '../src/services/screenClient';
import type { Task } from '../src/services/tasksClient';

import { installFakeApi, resetFakeApi, type FakeApi, type FakeHandler } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

type Api = ReturnType<typeof useAiChat>;

const baseTask: Task = {
  id: 't_handoff_img',
  title: '后台分析',
  goal: '分析这张图',
  origin: { createdBy: 'nomi', createdAt: 1, via: 'handoff', conversationId: 'conv-1' },
  trigger: { kind: 'manual' },
  executor: { kind: 'nomi', tools: ['read'] },
  grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: 1 },
  budget: { maxRetries: 0 },
  acceptance: 'auto',
  status: 'queued',
  enabled: true,
  gen: 1,
  consecutiveFailures: 0,
  updatedAt: 1,
};

const image = (id: string, data: string): ImageAttachment => ({
  id,
  mime: 'image/png',
  data,
  width: 32,
  height: 24,
  thumb: `data:image/png;base64,${data}`,
  source: 'paste',
});

const IMG_A = image('a', 'iVBORw0KGgoAAAANSUhEUg==');
const IMG_B = image('b', 'iVBORw0KGgoAAAANSUhEUg==BBBB');

/** 可手动推送 chunk 的假流：走真实 IPCClient（agentStream → 内核中止 / 错误照常处理） */
function fakeClient() {
  const queue: Array<{ type: string; content?: string; error?: string }> = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const upstream = new AbortController();
  const abortCalls: string[] = [];
  const chat = {
    async *agentStream() {
      for (;;) {
        if (upstream.signal.aborted) throw new Error('aborted upstream');
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (finished) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
    stream() {
      throw new Error('stream() should not be used when agentStream exists');
    },
    sendMessage: vi.fn(),
    abort(reqId: string) {
      abortCalls.push(reqId);
      upstream.abort();
      wake?.();
    },
  };
  const client = {
    chat,
    memory: { userProfile: { get: () => undefined, set: vi.fn() } },
    dispose: vi.fn(),
  };
  return {
    client: client as unknown as ClientAIClient,
    push(content: string) {
      queue.push({ type: 'delta', content });
      wake?.();
    },
    finish() {
      finished = true;
      wake?.();
    },
    abortCalls,
  };
}

function mount(client: ClientAIClient) {
  const ref: { api?: Api } = {};
  const Probe = () => {
    ref.api = useAiChat();
    return null;
  };
  render(
    <AiChatContextProvider client={client}>
      <Probe />
    </AiChatContextProvider>,
  );
  return ref as { api: Api };
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
/** 让排队的帧回调（streaming UI 合批用 rAF）执行 */
const frame = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    await new Promise((r) => setTimeout(r, 0));
  });

const OK_HANDLERS: Record<string, FakeHandler> = {
  'harness.state': () => ({ backend: 'nomi' }),
  'extensions.context': () => ({ text: '' }),
  'screen.checkSend': () => 'ok',
  'chatAssets.import': () => ({ url: 'chat-asset://images/user-1.png' }),
  'tasks.handoffFromChat': () => baseTask,
};

/** 发一轮（可带图），等流开始并推一段已生成内容 */
async function startTurn(
  ref: { api: Api },
  f: ReturnType<typeof fakeClient>,
  text: string,
  images?: ImageAttachment[],
) {
  let pending!: Promise<void>;
  await act(async () => {
    pending = ref.api.actions.sendStreamMessage(text, images);
    await new Promise((r) => setTimeout(r, 5));
  });
  f.push('已生成的前台内容');
  await frame();
  return { pending, done: () => act(async () => void (await pending)) };
}

const handoffInput = (fake: FakeApi) =>
  (fake.inputs('tasks.handoffFromChat') as Array<Record<string, unknown>>)[0]!;

describe('转后台：原图随接管交给后台，只有接管成功才停流', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    resetFakeApi();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('带说明的图：载荷含本轮原图 + 说明 + 已生成的部分；接管成功后中止前台这一轮', async () => {
    const fake = installFakeApi(OK_HANDLERS);
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const turn = await startTurn(ref, f, '按这个配色改首页', [IMG_A]);
    expect(ref.api.state.messages.find((m) => m.role === 'assistant')?.content).toBe(
      '已生成的前台内容',
    );
    expect(selectStreamingHere(ref.api.state)).toBe(true);

    let id: string | null = null;
    await act(async () => {
      id = await ref.api.actions.handoffCurrentToBackground();
    });
    expect(id).toBe('t_handoff_img');

    const input = handoffInput(fake);
    // 发给后台的载荷里是原图（不是前台气泡里的缩略图 / 本地地址）
    expect(input.images).toEqual([{ mime: 'image/png', data: IMG_A.data }]);
    expect(input.userGoal).toBe('按这个配色改首页');
    expect(String(input.partialContent)).toContain('已生成的前台内容');
    expect(typeof input.reqId).toBe('string');
    // 接管成功：前台这一轮被中止（上游 abort + 本地循环退出）
    expect(f.abortCalls).toHaveLength(1);
    await turn.done();
    expect(selectStreamingHere(ref.api.state)).toBe(false);
  });

  it('纯图（没有说明）：载荷仍带原图，userGoal 用占位说明而不是报错', async () => {
    const fake = installFakeApi(OK_HANDLERS);
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const turn = await startTurn(ref, f, '请看看这张图片。', [IMG_A, IMG_B]);

    let id: string | null = null;
    await act(async () => {
      id = await ref.api.actions.handoffCurrentToBackground();
    });
    expect(id).toBe('t_handoff_img');
    const input = handoffInput(fake);
    expect(input.images).toEqual([
      { mime: 'image/png', data: IMG_A.data },
      { mime: 'image/png', data: IMG_B.data },
    ]);
    // 与输入框「只发图」时一致：用「看一下这张图」代替空说明
    expect(input.userGoal).toBe('请看看这张图片。');
    await turn.done();
  });

  it('纯文字：载荷不带 images 字段，接管照常成功', async () => {
    const fake = installFakeApi(OK_HANDLERS);
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const turn = await startTurn(ref, f, '整理一下最近的调研');

    let id: string | null = null;
    await act(async () => {
      id = await ref.api.actions.handoffCurrentToBackground();
    });
    expect(id).toBe('t_handoff_img');
    const input = handoffInput(fake);
    expect('images' in input).toBe(false);
    expect(input.userGoal).toBe('整理一下最近的调研');
    expect(f.abortCalls).toHaveLength(1);
    await turn.done();
  });

  it('图片不可用（TASKS_IMAGE_UNAVAILABLE）：前台保留已输出内容并提示，流不停，后台没有任务', async () => {
    const fake = installFakeApi({
      ...OK_HANDLERS,
      'tasks.handoffFromChat': () => {
        throw new ContractError('TASKS_IMAGE_UNAVAILABLE', 'handoff image is not readable');
      },
    });
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const { pending, done } = await startTurn(ref, f, '看这张图', [IMG_A]);

    let id: string | null = 'unset';
    await act(async () => {
      id = await ref.api.actions.handoffCurrentToBackground();
    });
    expect(id).toBeNull();
    // 载荷确实带上了图（后台拒绝是因为图不可用，不是没发图）
    expect(handoffInput(fake).images).toEqual([{ mime: 'image/png', data: IMG_A.data }]);
    // 前台没被中止，已输出的内容还在，状态栏给出明确提示
    expect(f.abortCalls).toHaveLength(0);
    expect(selectStreamingHere(ref.api.state)).toBe(true);
    expect(ref.api.state.messages.find((m) => m.role === 'assistant')?.content).toBe(
      '已生成的前台内容',
    );
    expect(ref.api.state.messages.some((m) => m.handoffTaskId)).toBe(false);
    expect(ref.api.state.error).toContain('handoff image is not readable');
    expect(ref.api.state.error).toContain('前台已输出的内容保留');

    // 前台继续正常输出到结束
    f.push('，后续继续');
    await frame();
    f.finish();
    await done();
    const last = ref.api.state.messages.filter((m) => m.role === 'assistant').at(-1)!;
    expect(last.content).toBe('已生成的前台内容，后续继续');
    expect(last.error).toBeUndefined();
    expect(selectStreamingHere(ref.api.state)).toBe(false);
    // 只发了一次接管请求
    expect(fake.inputs('tasks.handoffFromChat')).toHaveLength(1);
    void pending;
  });

  it('存储失败（TASKS_STORAGE_ERROR）：同样保留前台并提示，不停流', async () => {
    const fake = installFakeApi({
      ...OK_HANDLERS,
      'tasks.handoffFromChat': () => {
        throw new ContractError('TASKS_STORAGE_ERROR', 'tasks store is unavailable');
      },
    });
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const { done } = await startTurn(ref, f, '继续之前的分析', [IMG_A]);

    let id: string | null = 'unset';
    await act(async () => {
      id = await ref.api.actions.handoffCurrentToBackground();
    });
    expect(id).toBeNull();
    expect(f.abortCalls).toHaveLength(0);
    expect(selectStreamingHere(ref.api.state)).toBe(true);
    expect(ref.api.state.error).toBe(
      t('ui.providers-schedule.task-handoff-failed-kept-foreground', 'tasks store is unavailable'),
    );
    expect(ref.api.state.messages.find((m) => m.role === 'assistant')?.content).toBe(
      '已生成的前台内容',
    );
    expect(fake.inputs('tasks.handoffFromChat')).toHaveLength(1);
    f.finish();
    await done();
  });

  it('没有返回 task.id：不凭「有返回」就停流，提示未接管', async () => {
    const fake = installFakeApi({
      ...OK_HANDLERS,
      'tasks.handoffFromChat': () => ({ ...baseTask, id: '' }),
    });
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const { done } = await startTurn(ref, f, '纯文字也试一下');

    let id: string | null = 'unset';
    await act(async () => {
      id = await ref.api.actions.handoffCurrentToBackground();
    });
    expect(id).toBeNull();
    expect(f.abortCalls).toHaveLength(0);
    expect(selectStreamingHere(ref.api.state)).toBe(true);
    expect(ref.api.state.error).toContain('后台没有接管这一轮');
    expect(fake.inputs('tasks.handoffFromChat')).toHaveLength(1);
    f.finish();
    await done();
  });

  it('重复点击（同一轮）：只接管一次，复用同一个任务 id', async () => {
    let release!: (task: Task) => void;
    const fake = installFakeApi({
      ...OK_HANDLERS,
      'tasks.handoffFromChat': () =>
        new Promise<Task>((resolve) => {
          release = resolve;
        }),
    });
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const turn = await startTurn(ref, f, '并发点击', [IMG_A]);

    const ids: Array<string | null> = [];
    let p1!: Promise<string | null>;
    let p2!: Promise<string | null>;
    await act(async () => {
      p1 = ref.api.actions.handoffCurrentToBackground();
      p2 = ref.api.actions.handoffCurrentToBackground();
    });
    await act(async () => {
      release({ ...baseTask, id: 't_once' });
      ids.push(await p1, await p2);
    });
    expect(ids).toEqual(['t_once', 't_once']);
    // 交接完成后前台已退出；紧接着再点一次也不会再建任务
    await turn.done();
    await act(async () => {
      ids.push(await ref.api.actions.handoffCurrentToBackground());
    });
    expect(ids.at(-1)).toBeNull();
    expect(fake.inputs('tasks.handoffFromChat')).toHaveLength(1);
    expect(f.abortCalls).toHaveLength(1);
  });

  it('重复点击（失败后）：失败只接管一次，不重发、不叠加提示', async () => {
    const handler = vi.fn(() => {
      throw new ContractError('TASKS_STORAGE_ERROR', 'disk full');
    });
    installFakeApi({ ...OK_HANDLERS, 'tasks.handoffFromChat': handler });
    const f = fakeClient();
    const ref = mount(f.client);
    await flush();
    const { done } = await startTurn(ref, f, '点两次');

    const ids: Array<string | null> = [];
    await act(async () => {
      ids.push(
        await ref.api.actions.handoffCurrentToBackground(),
        await ref.api.actions.handoffCurrentToBackground(),
      );
    });
    expect(ids).toEqual([null, null]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.abortCalls).toHaveLength(0);
    expect(selectStreamingHere(ref.api.state)).toBe(true);
    f.finish();
    await done();
  });
});
