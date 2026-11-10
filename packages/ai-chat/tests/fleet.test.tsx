// @vitest-environment happy-dom
/** Agent 看板：总览（调度者 / 空闲进程）+ 四列（含外部会话、只读）、归档、标题栏负载指示与浮层、导航栏负载环 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetNav } from '../src/components/Fleet';
import { FleetIndicator } from '../src/components/Fleet/FleetIndicator';
import { FleetPage } from '../src/components/Fleet/FleetPage';
import { useFleet } from '../src/components/Fleet/useFleet';
import { formatBytes, summarize, type FleetState } from '../src/services/fleetClient';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const T0 = 1_800_000_000_000;

const usage = (bytes: number, cpu = 0, processes = 1) => ({
  rssBytes: bytes,
  cpuPercent: cpu,
  processes,
});

const state: FleetState = {
  agents: [
    {
      id: 'chat:c1',
      kind: 'nomi',
      backend: 'nomi',
      scope: 'managed',
      origin: 'chat',
      title: '',
      column: 'running',
      conversationId: 'c1',
      updatedAt: T0,
    },
    {
      id: 'tab:a',
      kind: 'cli',
      backend: 'claude',
      scope: 'managed',
      origin: 'conversation',
      title: '修复流式',
      column: 'running',
      needsYou: 'permission',
      tabId: 'a',
      taskId: 't1',
      cwd: '/Users/me/repo',
      usage: usage(1.5 * GB, 120, 4),
      updatedAt: T0,
    },
    {
      id: 'run:t2',
      kind: 'nomi',
      backend: 'nomi',
      scope: 'managed',
      origin: 'nomi',
      title: '写周报',
      column: 'todo',
      taskId: 't2',
      updatedAt: T0,
    },
    {
      id: 'tab:b',
      kind: 'cli',
      backend: 'codex',
      scope: 'managed',
      origin: 'workbench',
      title: '重构 UI',
      column: 'done',
      tabId: 'b',
      usage: usage(200 * MB),
      updatedAt: T0,
    },
    {
      id: 'tab:p',
      kind: 'cli',
      backend: 'codex',
      scope: 'managed',
      origin: 'task',
      title: '被暂停的',
      column: 'paused',
      tabId: 'p',
      paused: { by: 'memory', at: T0 },
      usage: usage(900 * MB),
      updatedAt: T0,
    },
    {
      id: 'ext:codex:s1',
      kind: 'cli',
      backend: 'codex',
      scope: 'external',
      origin: 'terminal',
      title: '终端里修 bug',
      column: 'running',
      cwd: '/proj',
      usage: usage(2 * GB, 50, 3),
      updatedAt: T0,
    },
    {
      id: 'ext:claude:s2',
      kind: 'cli',
      backend: 'claude',
      scope: 'external',
      origin: 'terminal',
      title: '等我回话',
      column: 'done',
      updatedAt: T0,
    },
    {
      id: 'ext:codex:s3',
      kind: 'cli',
      backend: 'codex',
      scope: 'external',
      origin: 'terminal',
      title: '做完了',
      column: 'done',
      summary: '修好了流式断开，测试都通过了',
      updatedAt: T0,
    },
  ],
  nomi: { usage: usage(300 * MB, 3, 2) },
  externalIdle: {
    processes: 4,
    rssBytes: 100 * MB,
    items: [
      { pid: 3076, backend: 'codex', cwd: '/w/a', processes: 1, rssBytes: 60 * MB, cpuPercent: 0 },
      { pid: 3199, backend: 'codex', processes: 2, rssBytes: 20 * MB, cpuPercent: 0.5 },
      { pid: 64826, backend: 'grok', processes: 1, rssBytes: 20 * MB, cpuPercent: 0 },
    ],
  },
  system: {
    totalMemBytes: 16 * GB,
    cores: 8,
    cpuPercent: 12,
    pressure: 'normal',
    availablePercent: 45,
  },
  governor: { autoPause: true, last: { kind: 'paused', id: 'tab:p', at: T0 - 60_000 } },
  policy: { mode: 'balanced', maxParallel: 5 },
  policyOptions: [
    { mode: 'saver', maxParallel: 3 },
    { mode: 'balanced', maxParallel: 5 },
    { mode: 'max', maxParallel: 0 },
  ],
  sampledAt: T0,
};

const chatName = (id: string) => (id === 'c1' ? '周末计划' : '');

let fake: FakeApi;
beforeEach(() => {
  fake = installFakeApi({
    'fleet.state': () => state,
    'fleet.archive': ({ id }: { id: string }) => ({
      ...state,
      agents: state.agents.filter((a) => a.id !== id),
    }),
  });
});
afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('summarize / format', () => {
  it('counts Nomi with the managed side and idle processes with the external side', () => {
    const s = summarize(state);
    expect(s.managedBytes).toBe(300 * MB + 1.5 * GB + 200 * MB + 900 * MB);
    expect(s.externalBytes).toBe(2 * GB + 100 * MB);
    expect(s.agentsBytes).toBe(1.5 * GB + 200 * MB + 900 * MB + 2 * GB);
    // 进行中：正在回答的对话、Nomi 派出的、外部会话都算
    expect(s.running).toBe(3);
    expect(s.needsYou).toBe(1);
    expect(s.level).toBe('normal');
  });

  it('follows the system memory pressure; estimates only when it is unknown', () => {
    const at = (pressure: FleetState['system']['pressure'], extra = {}) =>
      summarize({ ...state, system: { ...state.system, pressure, ...extra } }).level;
    expect(at('critical')).toBe('critical');
    expect(at('warn')).toBe('warn');
    expect(at('normal')).toBe('normal');
    // 正常的内存压力下 CPU 很高：提成告警
    expect(at('normal', { cpuPercent: 90 })).toBe('warn');
    // 读不到压力：按占用比例估（≈ 5 GB / 5 GB）
    expect(at('unknown', { totalMemBytes: 5 * GB })).toBe('critical');
    expect(at('unknown', { cpuPercent: 60 })).toBe('warn');
    expect(summarize(null).level).toBe('normal');
  });

  it('formats bytes', () => {
    expect(formatBytes(512 * 1024)).toBe('< 1 MB');
    expect(formatBytes(300 * MB)).toBe('300 MB');
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB');
    expect(formatBytes(12 * GB)).toBe('12 GB');
  });
});

describe('FleetPage', () => {
  it('shows the dispatch policy the kernel reports and lets the user pick one', () => {
    const onSetPolicy = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onSetPolicy={onSetPolicy} />);
    expect(screen.queryByTestId('fleet-card-nomi')).toBeNull();
    expect(screen.getByTestId('fleet-summary').textContent).toContain('12%');
    const balanced = screen.getByTestId('fleet-policy-balanced');
    expect(balanced.getAttribute('aria-checked')).toBe('true');
    // 数值照内核给的写
    expect(screen.getByTestId('fleet-policy-saver').textContent).toContain('3');
    expect(screen.getByTestId('fleet-policy-balanced').textContent).toContain('5');
    // 全速不设个数上限：写按 CPU 与内存放行
    expect(screen.getByTestId('fleet-policy-max').textContent).toContain('CPU');
    fireEvent.click(balanced);
    expect(onSetPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('fleet-policy-saver'));
    expect(onSetPolicy).toHaveBeenCalledWith('saver');
  });

  it('shows every working agent, managed and external, filterable by status', () => {
    render(<FleetPage active state={state} onBack={() => undefined} chatName={chatName} />);
    const grid = () => screen.getByTestId('fleet-grid');
    const columnOf = (text: string) =>
      within(grid()).getByText(text).closest('li')?.getAttribute('data-column');
    expect(columnOf('周末计划')).toBe('running');
    expect(columnOf('修复流式')).toBe('running');
    expect(screen.getByTestId('fleet-needs-tab:a')).toBeTruthy();
    expect(columnOf('终端里修 bug')).toBe('running');
    expect(columnOf('写周报')).toBe('todo');
    expect(columnOf('重构 UI')).toBe('done');
    expect(columnOf('做完了')).toBe('done');
    // 做完的卡片带上总结
    expect(screen.getByTestId('fleet-summary-ext:codex:s3').textContent).toContain('测试都通过了');
    // 终端里等你回话 = 这一轮答完了：算已完成，不标「要你处理」
    expect(columnOf('等我回话')).toBe('done');
    expect(screen.queryByTestId('fleet-needs-ext:claude:s2')).toBeNull();
    // 状态筛选：只剩那一类，计数是真实的条数
    const running = state.agents.filter((a) => a.column === 'running').length;
    expect(screen.getByTestId('fleet-filter-running').textContent).toContain(String(running));
    fireEvent.click(screen.getByTestId('fleet-filter-done'));
    expect(within(grid()).queryByText('周末计划')).toBeNull();
    expect(within(grid()).getByText('重构 UI')).toBeTruthy();
  });

  it('searches by title', () => {
    render(<FleetPage active state={state} onBack={() => undefined} chatName={chatName} />);
    fireEvent.change(screen.getByTestId('fleet-search'), { target: { value: '周报' } });
    expect(within(screen.getByTestId('fleet-grid')).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByTestId('fleet-search'), { target: { value: '没有这个' } });
    expect(screen.getByTestId('fleet-empty')).toBeTruthy();
  });

  it('lists idle processes separately, one row each, closable by hand', () => {
    const onCloseIdle = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onCloseIdle={onCloseIdle} />);
    const list = screen.getByTestId('fleet-idle-list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    const row = screen.getByTestId('fleet-idle-3076');
    expect(row.textContent).toContain('3076');
    expect(row.textContent).toContain('60 MB');
    expect(row.textContent).toContain('a');
    fireEvent.click(screen.getByTestId('fleet-close-idle-64826'));
    expect(onCloseIdle).toHaveBeenCalledWith([state.externalIdle.items[2]]);
  });

  it('closes several idle processes at once: pick rows or select all', () => {
    const onCloseIdle = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onCloseIdle={onCloseIdle} />);
    const [first, , third] = state.externalIdle.items;
    const closeSelected = screen.getByTestId('fleet-close-idle-selected') as HTMLButtonElement;
    expect(closeSelected.disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`fleet-idle-pick-${first.pid}`));
    fireEvent.click(screen.getByTestId(`fleet-idle-pick-${third.pid}`));
    const all = screen.getByTestId('fleet-idle-select-all') as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    expect(closeSelected.textContent).toContain('2');
    fireEvent.click(closeSelected);
    expect(onCloseIdle).toHaveBeenLastCalledWith([first, third]);
    // 关完清空勾选；全选一次勾上全部
    expect(closeSelected.disabled).toBe(true);
    fireEvent.click(all);
    fireEvent.click(closeSelected);
    expect(onCloseIdle).toHaveBeenLastCalledWith(state.externalIdle.items);
  });

  it('says why an idle process was not closed (no permission on Windows, no longer idle)', () => {
    const view = render(
      <FleetPage
        active
        state={state}
        onBack={() => undefined}
        onCloseIdle={() => undefined}
        idleErrors={[{ pid: 3076, backend: 'codex', reason: 'denied' }]}
      />,
    );
    const msg = screen.getByTestId('fleet-close-idle-error').textContent ?? '';
    expect(msg).toContain('3076');
    expect(msg).toContain('管理员');
    view.rerender(
      <FleetPage
        active
        state={state}
        onBack={() => undefined}
        idleErrors={[{ pid: 3076, backend: 'codex', reason: 'gone' }]}
      />,
    );
    expect(screen.getByTestId('fleet-close-idle-error').textContent).toContain('已经不是空闲进程');
  });

  it('has no idle list when there are no idle processes', () => {
    const none = { ...state, externalIdle: { processes: 0, rssBytes: 0, items: [] } };
    render(<FleetPage active state={none} onBack={() => undefined} />);
    expect(screen.queryByTestId('fleet-idle-list')).toBeNull();
    expect(screen.queryByTestId('fleet-idle')).toBeNull();
  });

  it('external cards are read-only: no open / close buttons', () => {
    render(
      <FleetPage
        active
        state={state}
        onBack={() => undefined}
        onOpenTab={() => undefined}
        onOpenTask={() => undefined}
        onCloseTab={() => undefined}
      />,
    );
    const card = screen.getByTestId('fleet-card-ext:codex:s1');
    expect(card.getAttribute('data-scope')).toBe('external');
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  it('done tabs have a close button at the bottom right, not in the menu', () => {
    const onCloseTab = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onCloseTab={onCloseTab} />);
    expect(screen.queryByTestId('fleet-close-tab-tab:a')).toBeNull();
    fireEvent.click(screen.getByTestId('fleet-close-tab-tab:b'));
    expect(onCloseTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'tab:b' }));
  });

  it('archives only done items', () => {
    const onArchive = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onArchive={onArchive} />);
    expect(screen.queryByTestId('fleet-more-tab:a')).toBeNull();
    fireEvent.click(screen.getByTestId('fleet-more-tab:b'));
    fireEvent.click(screen.getByTestId('fleet-archive-tab:b'));
    expect(onArchive).toHaveBeenCalledWith('tab:b');
  });

  it('opens the conversation of an answering Nomi chat', () => {
    const onOpenChat = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onOpenChat={onOpenChat} />);
    fireEvent.click(screen.getByTestId('fleet-more-chat:c1'));
    fireEvent.click(screen.getByTestId('fleet-open-chat-chat:c1'));
    expect(onOpenChat).toHaveBeenCalledWith('c1');
  });

  it('paused cards say who paused them and can be resumed; running ones can be paused', () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const withPausable = {
      ...state,
      agents: state.agents.map((a) =>
        a.id === 'tab:b' ? { ...a, column: 'running' as const, pausable: true } : a,
      ),
    };
    render(
      <FleetPage
        active
        state={withPausable}
        onBack={() => undefined}
        onPause={onPause}
        onResume={onResume}
      />,
    );
    expect(screen.getByText('被暂停的').closest('li')?.getAttribute('data-column')).toBe('paused');
    expect(screen.getByTestId('fleet-paused-tab:p').textContent).toContain('内存紧张');
    fireEvent.click(screen.getByTestId('fleet-resume-tab:p'));
    expect(onResume).toHaveBeenCalledWith('tab:p');
    fireEvent.click(screen.getByTestId('fleet-pause-tab:b'));
    expect(onPause).toHaveBeenCalledWith('tab:b');
    // 外部的、不可暂停的没有暂停按钮
    expect(screen.queryByTestId('fleet-pause-ext:codex:s1')).toBeNull();
    expect(screen.queryByTestId('fleet-pause-tab:a')).toBeNull();
  });

  it('shows the auto-pause switch, the memory pressure and what the guard did last', () => {
    const onSet = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onSetAutoPause={onSet} />);
    const sw = screen.getByTestId('fleet-auto-pause');
    fireEvent.click(sw.querySelector('input') ?? sw);
    expect(onSet).toHaveBeenCalledWith(false);
    const summary = screen.getByTestId('fleet-summary').textContent ?? '';
    expect(summary).toContain('正常');
    expect(summary).toContain('45%');
    expect(screen.getByTestId('fleet-governor').textContent).toContain('被暂停的');
  });

  it('hides an old guard notice', () => {
    const old = {
      ...state,
      governor: {
        autoPause: true,
        last: { kind: 'reclaimed' as const, count: 2, at: T0 - 3_600_000 },
      },
    };
    render(<FleetPage active state={old} onBack={() => undefined} />);
    expect(screen.queryByTestId('fleet-governor')).toBeNull();
  });

  it('marks held work, Nomi pauses and who dispatched a CLI', () => {
    const tree = {
      ...state,
      agents: state.agents.map((a) =>
        a.id === 'run:t2'
          ? { ...a, queueReason: 'memory' as const }
          : a.id === 'tab:p'
            ? { ...a, paused: { by: 'nomi' as const, at: T0 }, parentId: 'run:t2' }
            : a,
      ),
    };
    render(<FleetPage active state={tree} onBack={() => undefined} />);
    expect(screen.getByTestId('fleet-queue-run:t2').textContent).toContain('排队中');
    expect(screen.getByTestId('fleet-paused-tab:p').textContent).toContain('Nomi 暂停的');
    expect(screen.getByTestId('fleet-parent-tab:p').textContent).toContain('写周报');
  });

  it('pauses a background Nomi run as a task: after this turn, then until resumed (#317)', () => {
    const withRuns = (patch: Partial<(typeof state.agents)[number]>) => ({
      ...state,
      agents: state.agents.map((a) => (a.id === 'run:t2' ? { ...a, ...patch } : a)),
    });
    const { unmount } = render(
      <FleetPage
        active
        state={withRuns({ column: 'running', paused: { by: 'user', at: T0 } })}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByTestId('fleet-paused-run:t2').textContent).toContain('这一轮跑完后暂停');
    unmount();
    render(
      <FleetPage
        active
        state={withRuns({ column: 'paused', paused: { by: 'nomi', at: T0 } })}
        onBack={() => undefined}
      />,
    );
    const note = screen.getByTestId('fleet-paused-run:t2').textContent;
    expect(note).toContain('点继续恢复');
    expect(note).not.toContain('内存恢复后自动继续');
  });

  it('says why queued work is waiting', () => {
    const queued = {
      ...state,
      agents: state.agents.map((a) =>
        a.id === 'run:t2' ? { ...a, queueReason: 'retry' as const, retryAt: T0 + 3_600_000 } : a,
      ),
    };
    render(<FleetPage active state={queued} onBack={() => undefined} />);
    expect(screen.getByTestId('fleet-queue-run:t2').textContent).toContain('重试');
  });

  it('Esc goes back to the chat', () => {
    const onBack = vi.fn();
    render(<FleetPage active state={state} onBack={onBack} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBack).toHaveBeenCalled();
  });
});

describe('FleetIndicator', () => {
  it('shows running count and memory, opens a popover, Esc closes it', () => {
    const onOpenChange = vi.fn();
    render(
      <FleetIndicator
        state={state}
        onOpenBoard={() => undefined}
        onOpenChange={onOpenChange}
        chatName={chatName}
      />,
    );
    const btn = screen.getByTestId('fleet-indicator');
    expect(btn.textContent).toContain('3 ·');
    // 整机 CPU（0–100）也在指示里
    expect(btn.textContent).toContain('12%');
    fireEvent.click(btn);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const pop = screen.getByTestId('fleet-popover');
    // 正在跑的按内存从大到小
    const titles = within(pop)
      .getAllByRole('listitem')
      .map((li) => li.firstChild?.textContent);
    expect(titles[0]).toBe('终端里修 bug');
    expect(titles[1]).toBe('修复流式');
    expect(titles).toContain('周末计划');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('fleet-popover')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('opens the full board from the popover', () => {
    const onOpenBoard = vi.fn();
    render(<FleetIndicator state={state} onOpenBoard={onOpenBoard} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId('fleet-indicator'));
    fireEvent.click(screen.getByTestId('fleet-popover-open-board'));
    expect(onOpenBoard).toHaveBeenCalled();
    expect(screen.queryByTestId('fleet-popover')).toBeNull();
  });

  it('已经在看板上时，浮层不再提供打开看板', () => {
    render(
      <FleetIndicator
        state={state}
        onOpenBoard={() => undefined}
        onOpenChange={() => {}}
        boardOpen
      />,
    );
    fireEvent.click(screen.getByTestId('fleet-indicator'));
    expect(screen.queryByTestId('fleet-popover-open-board')).toBeNull();
  });
});

describe('FleetNav', () => {
  it('marks the icon with the load level', () => {
    const { rerender } = render(
      <FleetNav
        collapsed
        active={false}
        needsYou={0}
        running={2}
        level="normal"
        onOpen={() => {}}
      />,
    );
    const btn = screen.getByTestId('fleet-open');
    expect(btn.querySelector('[data-load]')).toBeNull();
    rerender(
      <FleetNav
        collapsed
        active={false}
        needsYou={1}
        running={2}
        level="critical"
        onOpen={() => {}}
      />,
    );
    expect(btn.querySelector('[data-load="critical"]')).toBeTruthy();
    // 收起时要你处理的只是一个小圆点，数量在提示与读屏文字里
    expect(screen.getByTestId('fleet-open-dot')).toBeTruthy();
    expect(btn.textContent).not.toMatch(/\d/);
    expect(btn.getAttribute('aria-label')).toContain('1');
  });
});

describe('useFleet', () => {
  const Probe: React.FC = () => {
    const { state: s } = useFleet(false);
    return <span data-testid="probe">{s ? s.agents.length : 'none'}</span>;
  };

  it('loads once and follows fleet.changed', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('8'));
    await act(() => fake.emit('fleet.changed', { ...state, agents: state.agents.slice(0, 2) }));
    expect(screen.getByTestId('probe').textContent).toBe('2');
  });
});
