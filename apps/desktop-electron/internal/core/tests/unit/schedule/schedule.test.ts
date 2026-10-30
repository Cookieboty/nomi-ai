jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReminderStore } from '../../../src/desktop/reminders/ReminderStore';
import {
  describeRepeat,
  firstRun,
  inQuiet,
  nextOccurrence,
  quietEndsAt,
  sanitizeRepeat,
} from '../../../src/schedule/recurrence';
import { SchedulerService, sanitizeSched } from '../../../src/schedule/SchedulerService';
import { fakeDesktop } from '../helpers/fakeDesktop';
import { featureHost } from '../helpers/featureHost';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe('recurrence', () => {
  it('daily / weekdays / weekly / monthly / interval', () => {
    const anchor = at(2026, 10, 12, 8, 0); // 周一
    expect(nextOccurrence({ kind: 'daily' }, anchor, anchor)).toBe(at(2026, 10, 13, 8));
    expect(nextOccurrence({ kind: 'daily' }, anchor, anchor - 1)).toBe(anchor);
    const fri = at(2026, 10, 16, 9);
    expect(nextOccurrence({ kind: 'weekdays' }, anchor, fri)).toBe(at(2026, 10, 19, 8));
    expect(nextOccurrence({ kind: 'weekly', days: [3, 5] }, anchor, anchor)).toBe(
      at(2026, 10, 14, 8),
    );
    expect(nextOccurrence({ kind: 'monthly' }, at(2026, 1, 31, 9), at(2026, 1, 31, 9))).toBe(
      at(2026, 2, 28, 9),
    );
    expect(nextOccurrence({ kind: 'interval', minutes: 30 }, anchor, anchor + 61 * 60_000)).toBe(
      anchor + 90 * 60_000,
    );
  });

  it('firstRun picks today when still ahead', () => {
    expect(firstRun('08:00', { kind: 'daily' }, at(2026, 10, 12, 7))).toBe(at(2026, 10, 12, 8));
    expect(firstRun('08:00', { kind: 'daily' }, at(2026, 10, 12, 9))).toBe(at(2026, 10, 13, 8));
    expect(firstRun('08:00', { kind: 'weekdays' }, at(2026, 10, 17, 7))).toBe(at(2026, 10, 19, 8));
  });

  it('quiet hours across midnight', () => {
    const q = { enabled: true, start: '22:00', end: '08:00' };
    expect(inQuiet(q, at(2026, 10, 12, 23))).toBe(true);
    expect(inQuiet(q, at(2026, 10, 12, 7, 59))).toBe(true);
    expect(inQuiet(q, at(2026, 10, 12, 12))).toBe(false);
    expect(inQuiet({ ...q, enabled: false }, at(2026, 10, 12, 23))).toBe(false);
    expect(quietEndsAt(q, at(2026, 10, 12, 23))).toBe(at(2026, 10, 13, 8));
    expect(quietEndsAt(q, at(2026, 10, 12, 12))).toBe(at(2026, 10, 12, 12));
  });

  it('sanitize + describe', () => {
    expect(sanitizeRepeat({ kind: 'weekly', days: [5, 1, 1, 9] })).toEqual({
      kind: 'weekly',
      days: [1, 5],
    });
    expect(sanitizeRepeat({ kind: 'interval', minutes: 1 })).toBeUndefined();
    expect(sanitizeRepeat({ kind: 'nope' })).toBeUndefined();
    expect(describeRepeat({ kind: 'weekly', days: [1, 3, 5] })).toBe('每周一、三、五');
    expect(describeRepeat({ kind: 'interval', minutes: 120 })).toBe('每 2 小时');
    expect(
      sanitizeSched({ quiet: { start: '25:00' }, proactive: { frequency: 'x' } }),
    ).toMatchObject({
      quiet: { start: '22:30' },
      proactive: { frequency: 'low', enabled: false },
    });
  });
});

describe('repeating reminders', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rem-')), 'r.json');
  const timers = { setTimeout: () => 1, clearTimeout: () => undefined };

  it('fires and reschedules, missed repeats announced once on start', () => {
    const file = tmp();
    let now = at(2026, 10, 12, 7);
    const s = new ReminderStore(file, () => now, timers);
    const fired: string[] = [];
    s.onFire = (r) => fired.push(`${r.text}@${new Date(r.dueAt).getDate()}`);
    const r = s.create('吃药', at(2026, 10, 12, 8), { kind: 'daily' });
    now = at(2026, 10, 12, 8);
    s.tick();
    expect(fired).toEqual(['吃药@12']);
    expect(s.get(r.id)).toMatchObject({
      status: 'pending',
      dueAt: at(2026, 10, 13, 8),
      fireCount: 1,
    });
    // 关机三天
    now = at(2026, 10, 16, 12);
    const s2 = new ReminderStore(file, () => now, timers);
    const missed = s2.start();
    expect(missed).toHaveLength(1);
    expect(missed[0].status).toBe('missed');
    expect(s2.get(r.id)).toMatchObject({ status: 'pending', dueAt: at(2026, 10, 17, 8) });
    expect(s2.today()).toHaveLength(0);
    s2.update(r.id, { repeat: null });
    expect(s2.get(r.id)?.repeat).toBeUndefined();
  });
});

describe('SchedulerService', () => {
  const mk = (complete: jest.Mock, now: { t: number }, idleSeconds = 5) => {
    const host = featureHost({ idleSeconds });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    const reminders = new ReminderStore(path.join(root, 'r.json'), () => now.t, {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    const say = jest.fn();
    const desktop = {
      ...fakeDesktop(say),
      audit: { append: jest.fn() },
      reminders,
      flushDeferred: jest.fn(),
      deferredCount: () => 0,
      notifyPolicy: null as unknown,
    };
    const svc = new SchedulerService({
      root,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: desktop as never,
      complete,
      memory: async () => '【用户档案】叫我小林',
      openChat: jest.fn(),
      now: () => now.t,
      ports: host.ports,
      events: host.events,
    });
    return { svc, desktop, reminders, root, events: host.events };
  };

  it('runs a daily briefing with reminders + memory context and reschedules', async () => {
    const now = { t: at(2026, 10, 12, 7, 59) };
    const complete = jest.fn(async () => '早上好小林！今天 10:00 有周会。');
    const { svc, desktop, reminders } = mk(complete, now);
    reminders.create('周会', at(2026, 10, 12, 10));
    const t = svc.upsertTask({
      name: '每日简报',
      prompt: '写简报',
      time: '08:00',
      repeat: { kind: 'daily' },
    });
    expect(t.nextRunAt).toBe(at(2026, 10, 12, 8));
    now.t = at(2026, 10, 12, 8, 0);
    await svc.tick();
    const sys = (complete.mock.calls[0] as unknown as [Array<{ content: string }>])[0][0].content;
    expect(sys).toContain('10:00 周会');
    expect(sys).toContain('叫我小林');
    expect(desktop.say).toHaveBeenCalledWith(expect.stringContaining('每日简报：早上好小林'));
    expect(svc.tasks()[0]).toMatchObject({ lastStatus: 'ok', nextRunAt: at(2026, 10, 13, 8) });
    expect(svc.results()[0]).toMatchObject({ ok: true, name: '每日简报' });
  });

  it('quiet hours suppress bubble but keep result; policy injected', async () => {
    const now = { t: at(2026, 10, 12, 23) };
    const { svc, desktop } = mk(
      jest.fn(async () => '晚安'),
      now,
    );
    svc.setSettings({ quiet: { enabled: true, start: '22:00', end: '07:00' } });
    const pol = desktop.notifyPolicy as { quiet(): boolean; quietEndsAt(): number };
    expect(pol.quiet()).toBe(true);
    expect(pol.quietEndsAt()).toBe(at(2026, 10, 13, 7));
    const t = svc.upsertTask({ name: 'x', prompt: 'y', time: '08:00', repeat: { kind: 'daily' } });
    await svc.runTask(t.id, { manual: true });
    expect(desktop.say).not.toHaveBeenCalled();
    expect(svc.results()).toHaveLength(1);
  });

  it('catches up missed tasks within 12h on start, records errors', async () => {
    jest.useFakeTimers();
    try {
      const now = { t: at(2026, 10, 12, 7) };
      const complete = jest.fn(async () => {
        throw new Error('offline');
      });
      const { svc } = mk(complete, now);
      svc.upsertTask({ name: 'x', prompt: 'y', time: '08:00', repeat: { kind: 'daily' } });
      now.t = at(2026, 10, 12, 11);
      svc.start();
      await jest.advanceTimersByTimeAsync(9000);
      svc.stop();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(svc.tasks()[0]).toMatchObject({
        lastStatus: 'error',
        lastError: 'offline',
        nextRunAt: at(2026, 10, 13, 8),
      });
      expect(svc.results()[0]).toMatchObject({ ok: false, catchUp: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('proactive gate respects opt-in, active hours, frequency and recent chat', async () => {
    const now = { t: at(2026, 10, 12, 10) };
    const { svc, desktop } = mk(
      jest.fn(async () => '要不要起来走走？'),
      now,
    );
    expect(svc.proactiveGate()).toEqual({ ok: false, reason: '未开启' });
    svc.setSettings({ proactive: { enabled: true, frequency: 'low' } });
    expect(svc.proactiveGate().ok).toBe(true);
    svc.noteActivity();
    expect(svc.proactiveGate().reason).toBe('你刚刚在聊天');
    now.t += 31 * 60_000;
    expect(await svc.maybeProactive(true)).toBe('要不要起来走走？');
    expect(desktop.say).toHaveBeenCalledWith('要不要起来走走？');
    expect(svc.proactiveGate().reason).toContain('今天已经搭话 1 次');
    now.t = at(2026, 10, 12, 22);
    svc.setSettings({ proactive: { frequency: 'high' } });
    expect(svc.proactiveGate().reason).toContain('不在活跃时段');
  });

  it('proactive gate reads idle time from the power port and publishes changes', () => {
    const now = { t: at(2026, 10, 12, 10) };
    const { svc, events } = mk(jest.fn(), now, 601);
    svc.setSettings({ proactive: { enabled: true, frequency: 'low' } });
    expect(svc.proactiveGate()).toMatchObject({ ok: false });
    expect(svc.proactiveGate().reason).toContain('不在电脑前');
    expect(events.published.map((e) => e.event)).toContain('sched.changed');
    expect(events.published.every((e) => e.surfaces === null)).toBe(true);
  });
});
