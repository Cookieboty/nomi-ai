// @vitest-environment happy-dom
/**
 * D1 看板娘窗口一侧：确认气泡、提醒卡片、打开语音设置走契约 `desktop.*` / `nav.*`（原 electronAPI）。
 * 假宿主用 `createTestClient(appContract, …)`（完整线协议、strict 序列化）。
 */
import type { Handlers } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createTestClient, type TestClient } from '@nomi-ai/contract/testing';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ client: null as null | { api: unknown } }));

vi.mock('@/services/api', () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!host.client) throw new Error('no fake host');
        const v = (host.client.api as Record<PropertyKey, unknown>)[key];
        return typeof v === 'function'
          ? (v as (...a: unknown[]) => unknown).bind(host.client.api)
          : v;
      },
    },
  ),
  hasTransport: () => host.client !== null,
  hasWindowHost: () => host.client !== null,
}));

import { DesktopConfirm } from '../../src/components/Mascot/DesktopConfirm';
import { ReminderCard } from '../../src/components/Mascot/ReminderCard';
import { openVoiceSettings } from '../../src/mascot/openVoiceSettings';

let current: TestClient<AppContract> | null = null;

function install(handlers: Partial<Handlers<AppContract>>): TestClient<AppContract> {
  current = createTestClient(appContract, handlers, {
    caller: { surface: 'mascot', trusted: true },
  });
  host.client = current;
  return current;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  cleanup();
  current?.close();
  current = null;
  host.client = null;
});

describe('DesktopConfirm', () => {
  it('确认请求经 desktop.confirmRequest 到达；答复经 desktop.confirmAnswer；取消事件移除气泡', async () => {
    const answer = vi.fn();
    const t = install({ 'desktop.confirmAnswer': answer });
    render(<DesktopConfirm />);
    await act(tick);
    const req = {
      id: 'c1',
      tool: 'fs_write_text',
      danger: 'write',
      summary: '写入 a.txt',
      argsJson: '{}',
      dialog: false,
      rememberable: true,
      reason: 'policy',
      expiresAt: Date.now() + 60_000,
    };
    await act(async () => {
      t.router.events.publish('desktop.confirmRequest', req);
      await tick();
    });
    fireEvent.click(screen.getByTestId('desktop-confirm-allow'));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith(
        { id: 'c1', allow: true, remember: false },
        expect.anything(),
      ),
    );
    expect(screen.queryByTestId('desktop-confirm-bubble')).toBeNull();

    await act(async () => {
      t.router.events.publish('desktop.confirmRequest', { ...req, id: 'c2' });
      await tick();
    });
    expect(screen.getByTestId('desktop-confirm-bubble')).toBeTruthy();
    await act(async () => {
      t.router.events.publish('desktop.confirmCancel', 'c2');
      await tick();
    });
    expect(screen.queryByTestId('desktop-confirm-bubble')).toBeNull();
  });

  it('没有契约传输时不渲染', () => {
    const { container } = render(<DesktopConfirm />);
    expect(container.innerHTML).toBe('');
  });
});

describe('ReminderCard', () => {
  it('挂载后拉取错过的提醒；卡片按钮经 desktop.reminderAction；到点事件追加卡片', async () => {
    const action = vi.fn();
    const t = install({
      'desktop.takeMissedReminders': () => [{ id: 'r0', text: '喝水', dueAt: 1 }],
      'desktop.reminderAction': action,
    });
    render(<ReminderCard />);
    await waitFor(() => expect(screen.getByTestId('reminder-card').dataset.missed).toBe('1'));
    await act(async () => {
      t.router.events.publish('desktop.reminder', { id: 'r1', text: '开会', dueAt: 2 });
      await tick();
    });
    fireEvent.click(screen.getByTestId('reminder-snooze'));
    await waitFor(() =>
      expect(action).toHaveBeenCalledWith(
        { id: 'r0', action: 'snooze', minutes: 10 },
        expect.anything(),
      ),
    );
    expect(screen.getByTestId('reminder-card').dataset.missed).toBe('0');
    fireEvent.click(screen.getByTestId('reminder-dismiss'));
    await waitFor(() =>
      expect(action).toHaveBeenLastCalledWith(
        { id: 'r1', action: 'dismiss', minutes: 10 },
        expect.anything(),
      ),
    );
  });
});

describe('openVoiceSettings', () => {
  it('经 nav.openVoiceSettings 打开；失败或没有传输时返回 false', async () => {
    await expect(openVoiceSettings()).resolves.toBe(false);
    const open = vi.fn();
    install({ 'nav.openVoiceSettings': open });
    await expect(openVoiceSettings()).resolves.toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockImplementationOnce(() => {
      throw new Error('no window');
    });
    await expect(openVoiceSettings()).resolves.toBe(false);
  });
});
