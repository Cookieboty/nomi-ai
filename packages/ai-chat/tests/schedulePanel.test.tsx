// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SchedulePanel } from '../src/components/SchedulePanel';
import { describeRepeat } from '../src/services/desktopClient';

import type { ApiMockState } from './helpers/knowledgeApi';

// sched.* / desktop.*（提醒）走契约（services/api）：调用记进 mockIpc 返回的 invoke
const mock = vi.hoisted(() => ({ transport: true }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(mock),
);

afterEach(() => {
  cleanup();
  delete (window as { aiIPC?: unknown }).aiIPC;
  mock.invoke = undefined;
});

const state = (over: Record<string, unknown> = {}) => ({
  settings: {
    quiet: { enabled: true, start: '22:00', end: '08:00' },
    proactive: {
      enabled: false,
      frequency: 'low',
      activeStart: '09:00',
      activeEnd: '21:00',
      skipIfChattedMin: 30,
    },
  },
  tasks: [],
  running: [],
  quietNow: true,
  deferred: 2,
  proactive: { today: 0, lastAt: 0, gate: { ok: false, reason: '未开启' } },
  ...over,
});

function mockIpc(extra: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch in extra) return extra[ch];
    if (ch === 'sched.state') return state();
    if (ch === 'sched.results') return [];
    if (ch === 'desktop.remindersList') return [];
    if (ch === 'sched.upsertTask') return { id: 't1', nextRunAt: Date.now() + 1000 };
    if (ch === 'desktop.remindersCreate')
      return {
        id: 'r1',
        text: '喝水',
        dueAt: Date.now() + 1000,
        status: 'pending',
        createdAt: 0,
        repeat: { kind: 'daily' },
      };
    return true;
  });
  (window as { aiIPC?: unknown }).aiIPC = { invoke, on: () => () => undefined };
  mock.invoke = (name, input) => invoke(name, input);
  return invoke;
}

describe('schedule panel', () => {
  it('shows quiet status and creates a repeating reminder', async () => {
    const invoke = mockIpc();
    const r = render(<SchedulePanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByTestId('quiet-badge').textContent).toContain('免打扰中'));
    expect(r.getByText('2 条提醒待补报')).toBeTruthy();
    fireEvent.change(r.getByTestId('reminder-text'), { target: { value: '喝水' } });
    // custom Select 底层是隐藏的原生 select
    const rep = r.container.querySelector(
      'select[data-testid="reminder-repeat"]',
    ) as HTMLSelectElement | null;
    if (rep) fireEvent.change(rep, { target: { value: 'daily' } });
    fireEvent.click(r.getByTestId('reminder-add'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'desktop.remindersCreate',
        expect.objectContaining({ text: '喝水', inMinutes: 10 }),
      ),
    );
    await waitFor(() => expect(r.getByTestId('sched-msg').textContent).toContain('喝水'));
  });

  it('adds the daily briefing and creates a custom task', async () => {
    const invoke = mockIpc();
    const r = render(<SchedulePanel isVisible onClose={() => undefined} />);
    await waitFor(() => r.getByRole('tab', { name: '定时任务' }));
    fireEvent.click(r.getByRole('tab', { name: '定时任务' }));
    fireEvent.click(await waitFor(() => r.getByTestId('task-add-briefing')));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sched.upsertTask',
        expect.objectContaining({
          name: '每日简报',
          template: 'briefing',
          repeat: { kind: 'daily' },
        }),
      ),
    );
    fireEvent.click(r.getByTestId('task-new'));
    fireEvent.change(r.getByTestId('task-name'), { target: { value: '周报' } });
    fireEvent.change(r.getByTestId('task-prompt'), { target: { value: '提醒我写周报' } });
    fireEvent.click(r.getByTestId('task-save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sched.upsertTask',
        expect.objectContaining({ name: '周报', prompt: '提醒我写周报', time: '08:00' }),
      ),
    );
  });

  it('toggles proactive chat and quiet hours', async () => {
    const invoke = mockIpc();
    const r = render(<SchedulePanel isVisible onClose={() => undefined} />);
    await waitFor(() => r.getByRole('tab', { name: '主动聊天' }));
    fireEvent.click(r.getByRole('tab', { name: '主动聊天' }));
    fireEvent.click(r.getByRole('switch', { name: '允许主动聊天' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('sched.setSettings', {
        proactive: { enabled: true },
      }),
    );
    expect(r.getByTestId('proactive-gate').textContent).toBe('已关闭');
  });

  it('describes repeat rules', () => {
    expect(describeRepeat({ kind: 'weekly', days: [5, 1] })).toBe('每周一、五');
    expect(describeRepeat(undefined)).toBe('不重复');
  });

  it('不再有「编程助手」标签：日程页只剩提醒 / 定时任务 / 主动聊天 / 免打扰', async () => {
    mockIpc();
    const r = render(<SchedulePanel isVisible onClose={() => undefined} />);
    await waitFor(() => r.getByTestId('quiet-badge'));
    const labels = Array.from(r.container.ownerDocument.querySelectorAll('[role=tab]')).map(
      (e) => e.textContent,
    );
    expect(labels).toEqual(['提醒', '定时任务', '主动聊天', '免打扰']);
    expect(r.queryByTestId('sched-agents')).toBeNull();
  });
});
