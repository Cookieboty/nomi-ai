import { describe, expect, it } from 'vitest';

import type { HarnessTraceEvent } from '../src/services/harnessClient';
import { deriveStatus } from '../src/utils/convStatus';
import { buildTimeline, reduceTrace } from '../src/utils/toolTrace';

const items = (trace: HarnessTraceEvent[], live = true) => buildTimeline(reduceTrace(trace), live);
const tool = (
  name: string,
  status: 'start' | 'done',
  id: string,
  input?: unknown,
): HarnessTraceEvent => ({
  type: 'tool',
  name,
  status,
  id,
  at: 1000,
  ...(input ? { input: JSON.stringify(input) } : {}),
});

describe('deriveStatus 等待态', () => {
  it('空闲无状态；排队有明确文案', () => {
    expect(deriveStatus({ phase: 'idle', items: [] })).toBeNull();
    const q = deriveStatus({ phase: 'queued', items: [] })!;
    expect(q.kind).toBe('queued');
    expect(q.label).toContain('排队等待');
  });

  it('刚发出、没有任何输出：等待模型首字', () => {
    expect(deriveStatus({ phase: 'running', live: { text: '' }, items: [] })!.kind).toBe(
      'first-token',
    );
    expect(deriveStatus({ phase: 'running', items: [] })!.kind).toBe('first-token');
  });

  it('权限 > 压缩 > 重试 / 重连 的优先级，带 (n/m)', () => {
    const base = { phase: 'running' as const, items: [] };
    expect(
      deriveStatus({
        ...base,
        live: { text: '', permissions: [{ id: 'p', summary: 'x' }], status: { kind: 'compact' } },
      })!.kind,
    ).toBe('permission');
    expect(deriveStatus({ ...base, live: { text: '', status: { kind: 'compact' } } })!.kind).toBe(
      'compact',
    );
    const retry = deriveStatus({
      ...base,
      live: { text: '', status: { kind: 'retry', attempt: 2, max: 5 } },
    })!;
    expect(retry.kind).toBe('retry');
    expect(retry.label).toContain('(2/5)');
    const re = deriveStatus({
      ...base,
      live: { text: '', status: { kind: 'reconnect', attempt: 1, max: 5 } },
    })!;
    expect(re.kind).toBe('reconnect');
    expect(re.label).toContain('重新连接');
  });

  it('子代理运行中优先于普通工具；工具运行显示动作与目标', () => {
    const sub = deriveStatus({
      phase: 'running',
      live: { text: '', firstEventAt: 1 },
      items: items([
        tool('spawn_subagent', 'start', 's', { description: '检查泄漏' }),
        tool('grep', 'start', 'g', { pattern: 'foo' }),
      ]),
    })!;
    expect(sub.kind).toBe('subagent');
    expect(sub.detail).toContain('检查泄漏');
    const t = deriveStatus({
      phase: 'running',
      live: { text: '', firstEventAt: 1 },
      items: items([tool('bash', 'start', 'b', { command: 'pnpm test' })]),
    })!;
    expect(t.kind).toBe('tool');
    expect(t.detail).toContain('pnpm test');
  });

  it('思考中 / 生成回复 / 兜底', () => {
    expect(
      deriveStatus({
        phase: 'running',
        live: { text: '', firstEventAt: 1 },
        items: items([{ type: 'thinking', text: '想', at: 1 }]),
      })!.kind,
    ).toBe('thinking');
    expect(
      deriveStatus({ phase: 'running', live: { text: '你好', firstEventAt: 1 }, items: [] })!.kind,
    ).toBe('writing');
    expect(
      deriveStatus({
        phase: 'running',
        live: { text: '', firstEventAt: 1 },
        items: items([tool('read_file', 'start', 'r'), tool('read_file', 'done', 'r')]),
      })!.kind,
    ).toBe('working');
  });
});

it('explicit thinking state overrides legacy traces, including status-only events', () => {
  const base = { phase: 'running' as const, items: [] };
  expect(deriveStatus({ ...base, live: { text: '', thinking: true } })?.kind).toBe('thinking');
  expect(deriveStatus({ ...base, live: { text: '', thinking: false } })?.kind).toBe('working');
  const trace = [{ type: 'thinking' as const, text: 'detail', at: 1, textAt: 0 }];
  expect(
    deriveStatus({
      phase: 'running',
      live: { text: '', thinking: false, trace },
      items: items(trace),
    })?.kind,
  ).toBe('working');
  expect(
    deriveStatus({ phase: 'running', live: { text: 'answer', trace }, items: items(trace) })?.kind,
  ).toBe('writing');
  expect(
    deriveStatus({ ...base, live: { text: '', trace: [{ type: 'thinking', text: '', at: 1 }] } })
      ?.kind,
  ).toBe('thinking');
});

describe('被权限系统拒掉的动作', () => {
  it('状态行说清楚是被拒，不是「慢」；detail 带上被拒的工具', () => {
    const st = deriveStatus({
      phase: 'running',
      live: { text: '', status: { kind: 'blocked', text: 'Task' } },
      items: [],
    })!;
    expect(st.kind).toBe('blocked');
    expect(st.label).toContain('校验不了');
    expect(st.detail).toBe('Task');
  });

  it('优先级在压缩 / 重试之上，权限确认之下', () => {
    const st = deriveStatus({
      phase: 'running',
      live: { text: '', status: { kind: 'blocked' } },
      items: [],
    })!;
    expect(st.kind).toBe('blocked');
    expect(st.detail).toBeUndefined();
  });
});
