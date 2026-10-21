/**
 * 看板娘关闭（隐藏）时的提醒：不发给隐藏的看板娘窗口，改走灵动岛 / 系统通知，点通知打开对话窗口。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

const shown: Array<{ title: string; body: string; click?: () => void }> = [];
jest.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: {},
  shell: {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn(), on: jest.fn() },
  Notification: Object.assign(
    jest.fn().mockImplementation((o: { title: string; body: string }) => {
      const rec: { title: string; body: string; click?: () => void } = { ...o };
      return {
        on: (ev: string, fn: () => void) => {
          if (ev === 'click') rec.click = fn;
        },
        show: () => shown.push(rec),
      };
    }),
    { isSupported: () => true },
  ),
}));

const island = jest.fn((_n: unknown) => true);
jest.mock('../../../src/island/IslandService', () => ({
  notifyIsland: (n: unknown) => island(n),
}));
jest.mock('../../../src/ai/mascotCommand', () => ({ broadcastMascotCommand: jest.fn() }));
jest.mock('../../../src/core/appIcon', () => ({ iconImage: () => undefined }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DesktopService } from '../../../src/desktop/DesktopService';
import type { Reminder } from '../../../src/desktop/reminders/ReminderStore';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function setup(opts: { hidden: boolean; osNotify?: boolean; window?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-route-'));
  const svc = new DesktopService(root, logger as never);
  const send = jest.fn();
  const win = {
    isDestroyed: () => false,
    isVisible: () => !opts.hidden,
    showInactive: jest.fn(),
    hide: jest.fn(),
    webContents: { send },
  };
  const openChat = jest.fn(async () => ({}) as never);
  svc.attachWindows({
    main: () => (opts.window === false ? null : (win as never)),
    openChat,
    mascotHidden: () => opts.hidden,
  });
  svc.notifyPolicy = {
    quiet: () => false,
    quietEndsAt: () => 0,
    osNotify: () => opts.osNotify ?? true,
  };
  const fire = (r: Partial<Reminder> = {}) =>
    (svc as unknown as { fireReminder(r: Reminder): void }).fireReminder({
      id: 'r1',
      text: 'drink water',
      dueAt: Date.now(),
      status: 'fired',
      createdAt: Date.now(),
      ...r,
    } as Reminder);
  return { svc, win, send, openChat, fire };
}

describe('reminder routing when the mascot is hidden', () => {
  beforeEach(() => {
    shown.length = 0;
    island.mockReset();
    island.mockReturnValue(true);
  });

  it('mascot visible: reminder card goes to the mascot window as before', () => {
    const t = setup({ hidden: false });
    t.fire();
    expect(t.send).toHaveBeenCalledWith('desktop:reminder', expect.objectContaining({ id: 'r1' }));
    expect(island).not.toHaveBeenCalled();
  });

  it('mascot hidden: no card / no show on the hidden mascot; island + system notification instead', () => {
    const t = setup({ hidden: true });
    t.fire();
    expect(t.send).not.toHaveBeenCalledWith('desktop:reminder', expect.anything());
    expect(t.win.showInactive).not.toHaveBeenCalled();
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reminder', body: 'drink water' }),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: '提醒', body: 'drink water' });
    // 点通知打开对话窗口，而不是把关掉的看板娘叫出来
    shown[0]!.click?.();
    expect(t.openChat).toHaveBeenCalled();
    expect(t.win.showInactive).not.toHaveBeenCalled();
  });

  it('mascot hidden and system notifications off: the island alone delivers it', () => {
    const t = setup({ hidden: true, osNotify: false });
    t.fire();
    expect(island).toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it('mascot hidden, notifications off and island unavailable: respects the setting, no system notification', () => {
    island.mockReturnValue(false);
    const t = setup({ hidden: true, osNotify: false });
    const audit = jest.spyOn(t.svc.audit, 'append');
    t.fire();
    expect(shown).toHaveLength(0);
    expect(t.send).not.toHaveBeenCalledWith('desktop:reminder', expect.anything());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'reminder_fire',
        args: expect.objectContaining({ id: 'r1', via: 'none' }),
        result: 'not_shown',
      }),
    );
  });

  it('mascot hidden, island unavailable, notifications on: the system notification delivers it', () => {
    island.mockReturnValue(false);
    const t = setup({ hidden: true, osNotify: true });
    const audit = jest.spyOn(t.svc.audit, 'append');
    t.fire();
    expect(shown).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ via: 'notification' }),
        result: 'ok',
      }),
    );
  });

  it('missed reminders with notifications off and no island: no system notification either', () => {
    island.mockReturnValue(false);
    const t = setup({ hidden: true, osNotify: false });
    (t.svc as unknown as { remindersStarted: boolean }).remindersStarted = true;
    (t.svc as unknown as { missedQueue: Reminder[] }).missedQueue = [
      { id: 'a', text: 'one', dueAt: 1, status: 'missed', createdAt: 1 },
    ] as Reminder[];
    jest.spyOn(t.svc.reminders, 'markAnnounced').mockImplementation(() => undefined);
    expect(t.svc.takeMissed()).toEqual([]);
    expect(shown).toHaveLength(0);
  });

  it('no mascot window at all: routed the same way', () => {
    const t = setup({ hidden: false, window: false });
    t.fire();
    expect(island).toHaveBeenCalled();
    expect(shown).toHaveLength(1);
  });

  it('missed reminders pulled while the mascot is hidden are delivered elsewhere, not queued as cards', () => {
    const t = setup({ hidden: true });
    const missed = [
      { id: 'a', text: 'one', dueAt: 1, status: 'missed', createdAt: 1 },
      { id: 'b', text: 'two', dueAt: 2, status: 'missed', createdAt: 1 },
    ] as Reminder[];
    (t.svc as unknown as { remindersStarted: boolean }).remindersStarted = true;
    (t.svc as unknown as { missedQueue: Reminder[] }).missedQueue = missed;
    jest.spyOn(t.svc.reminders, 'markAnnounced').mockImplementation(() => undefined);
    expect(t.svc.takeMissed()).toEqual([]);
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reminder', body: expect.stringContaining('one') }),
    );
    expect(shown).toHaveLength(1);
  });
});
