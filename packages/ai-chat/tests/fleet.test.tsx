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
  system: { totalMemBytes: 16 * GB, cores: 8, cpuPercent: 12 },
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
    expect(s.managedBytes).toBe(300 * MB + 1.5 * GB + 200 * MB);
    expect(s.externalBytes).toBe(2 * GB + 100 * MB);
    expect(s.agentsBytes).toBe(1.5 * GB + 200 * MB + 2 * GB);
    // 进行中：正在回答的对话、Nomi 派出的、外部会话都算
    expect(s.running).toBe(3);
    expect(s.needsYou).toBe(1);
    expect(s.level).toBe('normal');
  });

  it('raises the load level from memory share or whole-machine CPU (0–100)', () => {
    const heavy = { ...state, system: { ...state.system, totalMemBytes: 5 * GB } };
    // 300 MB + 1.7 GB + 2.1 GB ≈ 4.1 GB / 5 GB > 75%
    expect(summarize(heavy).level).toBe('critical');
    const cpu = { ...state, system: { ...state.system, cpuPercent: 60 } };
    expect(summarize(cpu).level).toBe('warn');
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
  it('shows Nomi as the dispatcher in the overview, not as a card', () => {
    render(<FleetPage active state={state} onBack={() => undefined} chatName={chatName} />);
    expect(screen.getByTestId('fleet-dispatcher').textContent).toContain('300 MB');
    expect(screen.queryByTestId('fleet-card-nomi')).toBeNull();
    // 空闲进程合并成一行
    const idle = screen.getByTestId('fleet-idle').textContent ?? '';
    expect(idle).toContain('Codex 2');
    expect(idle).toContain('Grok 1');
    expect(idle).toContain('100 MB');
    expect(screen.getByTestId('fleet-summary').textContent).toContain('12%');
  });

  it('puts every working agent, managed and external, into the columns', () => {
    render(<FleetPage active state={state} onBack={() => undefined} chatName={chatName} />);
    const running = screen.getByTestId('fleet-col-running');
    expect(within(running).getByText('周末计划')).toBeTruthy();
    expect(within(running).getByText('修复流式')).toBeTruthy();
    expect(within(running).getByTestId('fleet-needs-tab:a')).toBeTruthy();
    expect(within(running).getByText('终端里修 bug')).toBeTruthy();
    expect(within(screen.getByTestId('fleet-col-todo')).getByText('写周报')).toBeTruthy();
    const done = screen.getByTestId('fleet-col-done');
    expect(within(done).getByText('重构 UI')).toBeTruthy();
    expect(within(done).getByText('做完了')).toBeTruthy();
    // 终端里等你回话 = 这一轮答完了：算已完成，不标「要你处理」
    expect(within(done).getByText('等我回话')).toBeTruthy();
    expect(screen.queryByTestId('fleet-needs-ext:claude:s2')).toBeNull();
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
    expect(onCloseIdle).toHaveBeenCalledWith(state.externalIdle.items[2]);
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

  it('archives only done items', () => {
    const onArchive = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onArchive={onArchive} />);
    expect(screen.queryByTestId('fleet-archive-tab:a')).toBeNull();
    fireEvent.click(screen.getByTestId('fleet-archive-tab:b'));
    expect(onArchive).toHaveBeenCalledWith('tab:b');
  });

  it('opens the conversation of an answering Nomi chat', () => {
    const onOpenChat = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onOpenChat={onOpenChat} />);
    const card = screen.getByTestId('fleet-card-chat:c1');
    fireEvent.click(within(card).getByRole('button'));
    expect(onOpenChat).toHaveBeenCalledWith('c1');
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
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('7'));
    await act(() => fake.emit('fleet.changed', { ...state, agents: state.agents.slice(0, 2) }));
    expect(screen.getByTestId('probe').textContent).toBe('2');
  });
});
