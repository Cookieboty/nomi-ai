// @vitest-environment happy-dom
/** Agent 看板：四列 + 外部只读、归档、标题栏负载指示与浮层、导航栏负载环 */
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
      id: 'nomi',
      kind: 'nomi',
      backend: 'nomi',
      scope: 'managed',
      origin: 'self',
      title: '',
      column: 'running',
      usage: usage(300 * MB, 3, 2),
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
      id: 'ext:210',
      kind: 'cli',
      backend: 'codex',
      scope: 'external',
      origin: 'terminal',
      title: '',
      column: 'running',
      usage: usage(2 * GB, 50, 3),
      updatedAt: T0,
    },
  ],
  system: { totalMemBytes: 8 * GB, cores: 8, cpuPercent: 180 },
  sampledAt: T0,
};

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
  it('splits managed and external memory, counts running and needs-you', () => {
    const s = summarize(state);
    expect(s.managedBytes).toBe(300 * MB + 1.5 * GB + 200 * MB);
    expect(s.externalBytes).toBe(2 * GB);
    // 只数纳管、不含 Nomi 本体的「进行中」
    expect(s.running).toBe(1);
    expect(s.needsYou).toBe(1);
    expect(s.level).toBe('normal');
  });

  it('raises the load level from memory share or CPU share', () => {
    const heavy = { ...state, system: { ...state.system, totalMemBytes: 5 * GB } };
    // 纳管 + 外部共约 4.0 GB / 5 GB = 80%
    expect(summarize(heavy).level).toBe('critical');
    const cpu = { ...state, system: { ...state.system, cpuPercent: 450 } };
    expect(summarize(cpu).level).toBe('warn'); // 450 / 800
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
  it('puts managed agents in columns and external ones in a read-only section', () => {
    render(<FleetPage active state={state} onBack={() => undefined} onArchive={() => undefined} />);
    const running = screen.getByTestId('fleet-col-running');
    expect(within(running).getByText('修复流式')).toBeTruthy();
    expect(within(running).getByTestId('fleet-needs-tab:a')).toBeTruthy();
    expect(within(screen.getByTestId('fleet-col-todo')).getByText('写周报')).toBeTruthy();
    expect(within(screen.getByTestId('fleet-col-done')).getByText('重构 UI')).toBeTruthy();
    expect(within(screen.getByTestId('fleet-col-paused')).queryAllByRole('listitem')).toHaveLength(
      0,
    );
    const ext = screen.getByTestId('fleet-external');
    expect(within(ext).getByTestId('fleet-card-ext:210')).toBeTruthy();
    // 外部的不给任何操作
    expect(within(ext).queryAllByRole('button')).toHaveLength(0);
  });

  it('archives only done items', () => {
    const onArchive = vi.fn();
    render(<FleetPage active state={state} onBack={() => undefined} onArchive={onArchive} />);
    expect(screen.queryByTestId('fleet-archive-tab:a')).toBeNull();
    fireEvent.click(screen.getByTestId('fleet-archive-tab:b'));
    expect(onArchive).toHaveBeenCalledWith('tab:b');
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
    const onOpenBoard = vi.fn();
    render(<FleetIndicator state={state} onOpenBoard={onOpenBoard} onOpenChange={onOpenChange} />);
    const btn = screen.getByTestId('fleet-indicator');
    expect(btn.textContent).toContain('1 · 4.0 GB');
    fireEvent.click(btn);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const pop = screen.getByTestId('fleet-popover');
    // 正在跑的按内存从大到小；Nomi 本体不列
    const titles = within(pop)
      .getAllByRole('listitem')
      .map((li) => li.firstChild?.textContent);
    expect(titles[0]).toContain('Codex');
    expect(titles[1]).toBe('修复流式');
    expect(titles).toHaveLength(2);
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
    expect(btn.textContent).toContain('1');
  });
});

describe('useFleet', () => {
  const Probe: React.FC = () => {
    const { state: s } = useFleet(false);
    return <span data-testid="probe">{s ? s.agents.length : 'none'}</span>;
  };

  it('loads once and follows fleet.changed', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('5'));
    await act(() => fake.emit('fleet.changed', { ...state, agents: state.agents.slice(0, 2) }));
    expect(screen.getByTestId('probe').textContent).toBe('2');
  });
});
