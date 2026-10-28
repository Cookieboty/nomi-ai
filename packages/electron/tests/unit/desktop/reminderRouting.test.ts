/**
 * 提醒只走一个渠道：看板娘在 → 她的提醒卡片 / 气泡；看板娘关闭（隐藏）→ 灵动岛，灵动岛显示不了时
 * 才用系统通知（点通知打开对话窗口）。
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

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { DesktopService } from '../../../src/desktop/DesktopService';
import type { Reminder } from '../../../src/desktop/reminders/ReminderStore';
import { fakeHostPorts } from '../helpers/fakeHostPorts';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function setup(opts: { hidden: boolean; window?: boolean; quiet?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-route-'));
  const events = createRecordingAppEvents();
  const svc = new DesktopService(root, logger as never, {
    ports: fakeHostPorts({ userData: '/tmp', home: '/tmp' }),
    events,
  });
  // 发给看板娘窗口的事件（经事件总线，surface = mascot）
  const send = jest.fn();
  const publish = events.publish.bind(events);
  events.publish = (channel, payload, opts) => {
    publish(channel, payload, opts);
    if (opts?.surface === 'mascot') send(channel, payload);
  };
  const win = {
    isDestroyed: () => false,
    isVisible: () => !opts.hidden,
    showInactive: jest.fn(),
    hide: jest.fn(),
    webContents: { id: 7 },
  };
  const openChat = jest.fn(async () => ({}) as never);
  svc.attachWindows({
    main: () => (opts.window === false ? null : (win as never)),
    openChat,
    mascotHidden: () => opts.hidden,
  });
  svc.notifyPolicy = { quiet: () => opts.quiet ?? false, quietEndsAt: () => 0 };
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

describe('one channel per alert', () => {
  beforeEach(() => {
    shown.length = 0;
    island.mockReset();
    island.mockReturnValue(true);
  });

  it('mascot visible: reminder card on the mascot only — no island, no system notification', () => {
    const t = setup({ hidden: false });
    t.fire();
    expect(t.send).toHaveBeenCalledWith('desktop:reminder', expect.objectContaining({ id: 'r1' }));
    expect(island).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it('mascot hidden: no card / no show on the hidden mascot; the island alone delivers it', () => {
    const t = setup({ hidden: true });
    t.fire();
    expect(t.send).not.toHaveBeenCalledWith('desktop:reminder', expect.anything());
    expect(t.win.showInactive).not.toHaveBeenCalled();
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reminder', body: 'drink water' }),
    );
    expect(shown).toHaveLength(0);
  });

  it('mascot hidden, island unavailable: a system notification delivers it; click opens the chat', () => {
    island.mockReturnValue(false);
    const t = setup({ hidden: true });
    const audit = jest.spyOn(t.svc.audit, 'append');
    t.fire();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: '提醒', body: 'drink water' });
    shown[0]!.click?.();
    expect(t.openChat).toHaveBeenCalled();
    expect(t.win.showInactive).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'reminder_fire',
        args: expect.objectContaining({ via: 'notification' }),
        result: 'ok',
      }),
    );
  });

  it('no mascot window at all: routed like a hidden mascot', () => {
    const t = setup({ hidden: false, window: false });
    t.fire();
    expect(island).toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it('missed reminders pulled while the mascot is hidden: one combined island notice, no cards', () => {
    const t = setup({ hidden: true });
    const missed = [
      { id: 'a', text: 'one', dueAt: 1, status: 'missed', createdAt: 1 },
      { id: 'b', text: 'two', dueAt: 2, status: 'missed', createdAt: 1 },
    ] as Reminder[];
    (t.svc as unknown as { remindersStarted: boolean }).remindersStarted = true;
    (t.svc as unknown as { missedQueue: Reminder[] }).missedQueue = missed;
    jest.spyOn(t.svc.reminders, 'markAnnounced').mockImplementation(() => undefined);
    expect(t.svc.takeMissed()).toEqual([]);
    expect(island).toHaveBeenCalledTimes(1);
    expect(island).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reminder', body: expect.stringContaining('one') }),
    );
    expect(shown).toHaveLength(0);
  });

  it('notify(): bubble while shown; island, then system notification while hidden', () => {
    const n = {
      kind: 'agent' as const,
      title: 'Codex',
      text: 'done',
      bubble: { voice: 'cue' as const },
    };
    const visible = setup({ hidden: false });
    expect(visible.svc.notify(n)).toBe('bubble');
    expect(visible.send).toHaveBeenCalledWith('desktop:bubble', { text: 'done', voice: 'cue' });
    expect(island).not.toHaveBeenCalled();

    const hidden = setup({ hidden: true });
    expect(hidden.svc.notify(n)).toBe('island');
    expect(hidden.send).not.toHaveBeenCalledWith('desktop:bubble', expect.anything());
    expect(shown).toHaveLength(0);

    island.mockReturnValue(false);
    expect(hidden.svc.notify(n)).toBe('notification');
    expect(shown).toHaveLength(1);
  });

  it('notify(): no system notification for passive notices or during quiet hours', () => {
    island.mockReturnValue(false);
    const n = { kind: 'agent' as const, title: 'x', text: 'y' };
    expect(setup({ hidden: true }).svc.notify({ ...n, passive: true })).toBe('none');
    expect(setup({ hidden: true, quiet: true }).svc.notify(n)).toBe('none');
    expect(shown).toHaveLength(0);
  });
});
