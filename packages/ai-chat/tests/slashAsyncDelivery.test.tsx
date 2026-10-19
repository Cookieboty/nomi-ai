// @vitest-environment happy-dom
/**
 * issue #14：异步斜杠命令的产出（正文 / 卡片 / 错误提示 / 卡片按钮）必须回到「发起命令的会话」，
 * 用户在命令执行期间切到别的标签不能让结果串过去。全部用可控的 deferred Promise，不依赖时序。
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmd } from '../src/slash/adapters/common';
import type { SlashCommand } from '../src/slash/types';
import {
  useSlashCommands,
  type SlashHookParams,
  type SlashTarget,
} from '../src/slash/useSlashCommands';

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
type Deferred<T> = ReturnType<typeof deferred<T>>;

const gitDiffCalls: Array<{ cwd: string; gate: Deferred<unknown> }> = [];
const expandCalls: Array<{ backend: string; cwd: string; id: string }> = [];
const deactivateCalls: string[] = [];
vi.mock('../src/services/harnessClient', async (orig) => {
  const m = (await orig()) as Record<string, unknown> & { harnessClient: object };
  return {
    ...m,
    harnessClient: {
      ...m.harnessClient,
      available: () => true,
      slashDiscover: async (backend: string) => ({ backend, entries: [], supported: true }),
      gitDiff: (cwd: string) => {
        const gate = deferred<unknown>();
        gitDiffCalls.push({ cwd, gate });
        return gate.promise;
      },
      slashExpand: async (backend: string, cwd: string, id: string) => {
        expandCalls.push({ backend, cwd, id });
        return { text: `展开:${backend}:${cwd}`, shellInjection: false };
      },
    },
  };
});
vi.mock('../src/services/cliProviderClient', async (orig) => {
  const m = (await orig()) as Record<string, unknown> & { cliProviderClient: object };
  return {
    ...m,
    cliProviderClient: {
      ...m.cliProviderClient,
      deactivate: async (kind: string) => {
        deactivateCalls.push(kind);
        return { ok: true };
      },
      deactivateDsh: async () => {
        deactivateCalls.push('dsh');
        return { ok: true };
      },
    },
  };
});

beforeEach(() => {
  gitDiffCalls.length = 0;
  expandCalls.length = 0;
  deactivateCalls.length = 0;
});
afterEach(cleanup);

const diffOk = { ok: true, status: ' M a.ts', stat: '', diff: '', truncated: false };

const A = { scopeKey: 'tabA', tabId: 'a', backend: 'codex', cwd: '/a' } as const;
const B = { scopeKey: 'tabB', tabId: 'b', backend: 'claude', cwd: '/b' } as const;

const paramsFor = (
  side: typeof A | typeof B,
  over: Partial<SlashHookParams> = {},
): SlashHookParams => ({
  backend: side.backend,
  cwd: side.cwd,
  scopeKey: side.scopeKey,
  tabId: side.tabId,
  messages: [],
  session: { id: null, running: false },
  send: vi.fn(),
  newSession: vi.fn(),
  onOpenPlugins: vi.fn(),
  onOpenProviders: vi.fn(),
  onOpenSettings: vi.fn(),
  ...over,
});

/** 受控 sendTo：记录每次投递的目标与文本 */
function sink(result: boolean | ((t: SlashTarget) => boolean) = true) {
  const calls: Array<{ target: SlashTarget; text: string }> = [];
  const sendTo = vi.fn(async (target: SlashTarget, text: string) => {
    calls.push({ target, text });
    return typeof result === 'function' ? result(target) : result;
  });
  return { calls, sendTo };
}

function setup(over: Partial<SlashHookParams> = {}) {
  const { result, rerender, unmount } = renderHook((p: SlashHookParams) => useSlashCommands(p), {
    initialProps: paramsFor(A, over),
  });
  /** 切换到某个会话（保留 sendTo 等回调） */
  const switchTo = (side: typeof A | typeof B, extra: Partial<SlashHookParams> = {}) =>
    rerender(paramsFor(side, { ...over, ...extra }));
  const cardsIn = (side: typeof A | typeof B, extra: Partial<SlashHookParams> = {}) => {
    switchTo(side, extra);
    return result.current.cards;
  };
  const run = (text: string, all?: SlashCommand[]) => {
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.bridge.run(text, all ?? result.current.commands);
    });
    return p;
  };
  return { result, switchTo, cardsIn, run, unmount };
}

const skillCmd = (gate: Deferred<string>, name = 'review'): SlashCommand =>
  cmd({
    name,
    label: `/${name}`,
    description: '',
    source: 'skill',
    kind: 'expand',
    run: async () => ({ type: 'send', text: await gate.promise }),
  });

describe('正常路径（对照）', () => {
  it('不切换会话：正文只发一次、发给原目标；展开提示卡在原会话', async () => {
    const s = sink();
    const gate = deferred<string>();
    const t = setup({ sendTo: s.sendTo });
    const p = t.run('/review x', [skillCmd(gate)]);
    await act(async () => {
      gate.resolve('展开后的提示词');
      await p;
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.text).toBe('展开后的提示词');
    expect(s.calls[0]!.target).toMatchObject(A);
    expect(t.result.current.cards).toHaveLength(1);
    expect(t.result.current.cards[0]!.title).toBe('已展开并发送');
  });

  it('不切换会话：/diff 卡片只进原会话，不会发送任何文本', async () => {
    const s = sink();
    const t = setup({ sendTo: s.sendTo });
    const p = t.run('/diff');
    await act(async () => {
      gitDiffCalls[0]!.gate.resolve(diffOk);
      await p;
    });
    expect(t.result.current.cards).toHaveLength(1);
    expect(s.sendTo).not.toHaveBeenCalled();
  });
});

describe('A 发起 → 切到 B → 异步返回：B 什么都收不到', () => {
  it('skill 展开：正文发给 A 的目标（tabId/backend/cwd 都是 A 的），B 不收到正文与提示卡', async () => {
    const s = sink();
    const gate = deferred<string>();
    const t = setup({ sendTo: s.sendTo });
    const p = t.run('/review', [skillCmd(gate)]);
    t.switchTo(B, { sendTo: s.sendTo });
    await act(async () => {
      gate.resolve('属于 A 的提示词');
      await p;
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.target).toMatchObject({ tabId: 'a', backend: 'codex', cwd: '/a' });
    expect(t.result.current.cards).toHaveLength(0); // 现在显示的是 B
    expect(t.cardsIn(A, { sendTo: s.sendTo }).map((c) => c.title)).toEqual(['已展开并发送']);
    // 提示文案里的后端是 A 的（Codex），不是现在显示的 B
    const body = t.result.current.cards[0]!.body as { text: string };
    expect(body.text).not.toContain('Claude');
  });

  it('/diff 卡片：只属于 A（backend 也是 A 的），B 为空', async () => {
    const t = setup({ sendTo: sink().sendTo });
    const p = t.run('/diff');
    t.switchTo(B, {});
    await act(async () => {
      gitDiffCalls[0]!.gate.resolve(diffOk);
      await p;
    });
    expect(t.result.current.cards).toHaveLength(0);
    const inA = t.cardsIn(A);
    expect(inA).toHaveLength(1);
    expect(inA[0]!.backend).toBe('codex');
  });

  it('错误提示：命令失败的错误卡也只进 A', async () => {
    const gate = deferred<never>();
    const boom = cmd({
      name: 'boom',
      label: '/boom',
      description: '',
      source: 'builtin',
      kind: 'native',
      run: () => gate.promise,
    });
    const t = setup({ sendTo: sink().sendTo });
    const p = t.run('/boom', [boom]);
    t.switchTo(B);
    await act(async () => {
      gate.reject(new Error('展开失败'));
      await p;
    });
    expect(t.result.current.cards).toHaveLength(0);
    const inA = t.cardsIn(A);
    expect(inA).toHaveLength(1);
    expect((inA[0]!.body as { tone: string }).tone).toBe('error');
  });

  it('A/B 目录与后端不同：命令只读 A 的 cwd / backend（gitDiff、expand、deactivate 都不受切换影响）', async () => {
    const t = setup({ sendTo: sink().sendTo });
    // gitDiff 在发起时就用 A 的目录
    const p1 = t.run('/diff');
    t.switchTo(B);
    expect(gitDiffCalls[0]!.cwd).toBe('/a');
    await act(async () => {
      gitDiffCalls[0]!.gate.resolve(diffOk);
      await p1;
    });
    // 命令在 await 之后才调用 expand / deactivate：仍必须用 A 的 backend / cwd
    const gate = deferred<void>();
    const late = cmd({
      name: 'late',
      label: '/late',
      description: '',
      source: 'builtin',
      kind: 'native',
      run: async (_a, ctx) => {
        await gate.promise;
        await ctx.actions.expand('x', '');
        await ctx.actions.deactivateCliProfile();
        return { type: 'noop' };
      },
    });
    t.switchTo(A);
    const p2 = t.run('/late', [late]);
    t.switchTo(B);
    await act(async () => {
      gate.resolve();
      await p2;
    });
    expect(expandCalls).toEqual([{ backend: 'codex', cwd: '/a', id: 'x' }]);
    expect(deactivateCalls).toEqual(['codex']);
  });

  it('两个请求反序返回：各回各的会话', async () => {
    const s = sink();
    const gA = deferred<string>();
    const gB = deferred<string>();
    const t = setup({ sendTo: s.sendTo });
    const pA = t.run('/review', [skillCmd(gA)]);
    t.switchTo(B, { sendTo: s.sendTo });
    const pB = t.run('/review', [skillCmd(gB)]);
    await act(async () => {
      gB.resolve('B 的提示词');
      await pB;
      gA.resolve('A 的提示词');
      await pA;
    });
    const byTab = Object.fromEntries(s.calls.map((c) => [c.target.tabId, c.text]));
    expect(byTab).toEqual({ a: 'A 的提示词', b: 'B 的提示词' });
    expect(s.calls).toHaveLength(2);
    expect(t.result.current.cards).toHaveLength(1); // B 只有自己的一张
    expect(t.cardsIn(A, { sendTo: s.sendTo })).toHaveLength(1);
  });
});

describe('目标失效 / 卸载后不迟到发送', () => {
  it('原标签已关闭：不发送、不留卡片（只记日志）', async () => {
    const s = sink(false);
    const gate = deferred<string>();
    const t = setup({ sendTo: s.sendTo, tabExists: () => false });
    const p = t.run('/review', [skillCmd(gate)]);
    t.switchTo(B, { sendTo: s.sendTo, tabExists: () => false });
    await act(async () => {
      gate.resolve('x');
      await p;
    });
    expect(t.result.current.cards).toHaveLength(0);
    expect(t.cardsIn(A, { sendTo: s.sendTo, tabExists: () => false })).toHaveLength(0);
  });

  it('原会话被重置（sendTo 拒绝但标签还在）：丢弃并在原会话留提示，B 无任何东西', async () => {
    const s = sink(false);
    const gate = deferred<string>();
    const t = setup({ sendTo: s.sendTo, tabExists: () => true });
    const p = t.run('/review', [skillCmd(gate)]);
    t.switchTo(B, { sendTo: s.sendTo, tabExists: () => true });
    await act(async () => {
      gate.resolve('x');
      await p;
    });
    expect(t.result.current.cards).toHaveLength(0);
    const inA = t.cardsIn(A, { sendTo: s.sendTo, tabExists: () => true });
    expect(inA).toHaveLength(1);
    expect((inA[0]!.body as { text: string }).text).toContain('已丢弃');
    expect(inA.some((c) => c.title === '已展开并发送')).toBe(false);
  });

  it('组件卸载后到达的结果：不发送、不更新状态', async () => {
    const s = sink();
    const gate = deferred<string>();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = setup({ sendTo: s.sendTo });
    const p = t.run('/review', [skillCmd(gate)]);
    t.unmount();
    await act(async () => {
      gate.resolve('x');
      await p;
    });
    expect(s.sendTo).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('没有 sendTo 的兜底：目标已不是当前会话就丢弃，绝不转投给现在的会话', async () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const gate = deferred<string>();
    const t = setup({ send: sendA });
    const p = t.run('/review', [skillCmd(gate)]);
    t.switchTo(B, { send: sendB });
    await act(async () => {
      gate.resolve('x');
      await p;
    });
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
  });
});

describe('卡片后续按钮绑定原会话', () => {
  it('未知命令卡的「作为普通文字发送」：切到 B 后再点，仍发给 A', async () => {
    const s = sink();
    const t = setup({ sendTo: s.sendTo });
    await act(async () => {
      await t.result.current.bridge.run('/nope-cmd', t.result.current.commands);
    });
    const card = t.result.current.cards[0]!;
    const act1 = card.actions!.find((a) => a.id === 'send-plain')!;
    t.switchTo(B, { sendTo: s.sendTo });
    await act(async () => {
      await act1.run();
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.target).toMatchObject({ tabId: 'a', scopeKey: 'tabA' });
    expect(s.calls[0]!.text).toBe('/nope-cmd');
  });
});
