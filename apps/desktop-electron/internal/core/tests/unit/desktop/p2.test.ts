// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AppTrash } from '../../../src/desktop/AppTrash';
import { AuditLog } from '../../../src/desktop/AuditLog';
import { PermissionBroker, type ConfirmRequest } from '../../../src/desktop/PermissionBroker';
import { ReminderStore, resolveDue } from '../../../src/desktop/reminders/ReminderStore';
import { createDesktopTools } from '../../../src/desktop/tools';
import { UndoJournal } from '../../../src/desktop/UndoJournal';

type R = { ok: boolean; data?: Record<string, unknown>; error?: { code: string } };

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** 手动推进的时钟 + 计时器 */
function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  return {
    now: () => t,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        seq += 1;
        timers.push({ at: t + ms, fn, id: seq });
        return seq;
      },
      clearTimeout: (h: unknown) => {
        const i = timers.findIndex((x) => x.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    advance(ms: number) {
      t += ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
  };
}

describe('ReminderStore', () => {
  it('fires on time, persists, snoozes and cancels', () => {
    const c = fakeClock();
    const file = path.join(tmp('rem-'), 'reminders.json');
    const s = new ReminderStore(file, c.now, c.timers);
    const fired: string[] = [];
    s.onFire = (r) => fired.push(r.text);
    s.start();
    const a = s.create('喝水', c.now() + 5_000);
    const b = s.create('开会', c.now() + 60_000);
    c.advance(4_999);
    expect(fired).toEqual([]);
    c.advance(1);
    expect(fired).toEqual(['喝水']);
    expect(s.get(a.id)!.status).toBe('fired');
    s.cancel(b.id);
    c.advance(120_000);
    expect(fired).toEqual(['喝水']);
    s.snooze(a.id, 10);
    expect(s.get(a.id)!.status).toBe('pending');
    c.advance(10 * 60_000);
    expect(fired).toEqual(['喝水', '喝水']);
    expect(() => s.cancel(a.id)).toThrow(); // 已触发的不能取消
    const reloaded = new ReminderStore(file, c.now, c.timers);
    expect(
      reloaded
        .list({ includeEnded: true })
        .map((r) => r.status)
        .sort(),
    ).toEqual(['cancelled', 'fired']);
  });

  it('marks reminders that came due while closed as missed and announces once', () => {
    const c = fakeClock();
    const file = path.join(tmp('rem-'), 'reminders.json');
    const s1 = new ReminderStore(file, c.now, c.timers);
    s1.create('错过的', c.now() + 1_000);
    s1.create('马上到', c.now() + 3 * 60_000);
    s1.stop();
    c.advance(2 * 60_000 + 30_000); // “应用关闭”期间
    const s2 = new ReminderStore(file, c.now, c.timers);
    const fired: string[] = [];
    s2.onFire = (r) => fired.push(r.text);
    const missed = s2.start();
    expect(missed.map((r) => r.text)).toEqual(['错过的']);
    s2.markAnnounced(missed.map((r) => r.id));
    expect(new ReminderStore(file, c.now, c.timers).start()).toEqual([]);
    c.advance(60_000);
    expect(fired).toEqual(['马上到']);
  });

  it('resolves due times', () => {
    expect(resolveDue({ inSeconds: 5 }, 1000)).toBe(6000);
    expect(resolveDue({ inMinutes: 1 }, 0)).toBe(60_000);
    expect(resolveDue({ at: '2030-01-01T00:00:00Z' }, 0)).toBe(Date.UTC(2030, 0, 1));
    expect(resolveDue({ at: 'nope' }, 0)).toBeNull();
  });
});

describe('P2 tools', () => {
  function setup() {
    const root = tmp('p2-');
    const data = path.join(root, 'data');
    const broker = new PermissionBroker(
      path.join(data, 'settings.json'),
      {
        home: root,
        platform: process.platform,
        realpath: (p) => fs.promises.realpath(p),
        denyRoots: [data],
      },
      { timeoutMs: 2000 },
    );
    const asks: ConfirmRequest[] = [];
    let answer: (r: ConfirmRequest) => [boolean, boolean] = () => [true, false];
    broker.ui = {
      request: (r) => {
        asks.push(r);
        const [allow, remember] = answer(r);
        setTimeout(() => broker.answer(r.id, allow, remember), 0);
      },
      cancel: () => undefined,
    };
    const trash = new AppTrash(path.join(data, 'trash'));
    const journal = new UndoJournal(path.join(data, 'journal.jsonl'), trash);
    const c = fakeClock(Date.now());
    const reminders = new ReminderStore(path.join(data, 'reminders.json'), c.now, c.timers);
    let clip = 'secret-token-123';
    let writeError: Error | null = null;
    const said: string[] = [];
    const tools = createDesktopTools({
      broker,
      audit: new AuditLog(path.join(data, 'audit')),
      journal,
      trash,
      parse: async () => ({ ok: false, code: 'x', message: 'x' }),
      summarize: async () => '',
      providerFor: () => null,
      pickFolder: async () => null,
      p2: {
        reminders,
        clipboard: {
          readText: () => clip,
          writeText: async (t) => {
            if (writeError) throw writeError;
            clip = t;
          },
        },
        say: (t) => said.push(t),
        now: c.now,
      },
    });
    const call = async (name: string, input: unknown, signal?: AbortSignal) =>
      (await tools.find((t) => t.name === name)!.execute(input, { signal })) as R;
    return {
      call,
      asks,
      reminders,
      journal,
      broker,
      clock: c,
      said,
      clip: () => clip,
      failWrite: (e: Error) => (writeError = e),
      setAnswer: (f: typeof answer) => (answer = f),
    };
  }

  it('reminders: create / list / snooze / cancel + undo cancel', async () => {
    const t = setup();
    const r = await t.call('reminder_create', { text: '喝水', inSeconds: 3 });
    expect(r.ok).toBe(true);
    const id = r.data!.id as string;
    expect(((await t.call('reminder_list', {})).data!.reminders as unknown[]).length).toBe(1);
    expect(
      (await t.call('reminder_create', { text: 'x', at: '2000-01-01T00:00:00Z' })).error?.code,
    ).toBe('invalid_input');
    expect((await t.call('reminder_snooze', { id, minutes: 5 })).ok).toBe(true);
    expect((await t.call('reminder_cancel', { id })).ok).toBe(true);
    expect(t.reminders.get(id)!.status).toBe('cancelled');
    await t.journal.undo(t.journal.last()!);
    expect(t.reminders.get(id)!.status).toBe('pending');
  });

  it('clipboard: read needs consent (per run), content is untrusted, denial blocks it', async () => {
    const t = setup();
    t.setAnswer(() => [false, false]);
    const denied = await t.call('clipboard_read', {});
    expect(denied.error?.code).toBe('user_denied');
    expect(t.asks.at(-1)).toMatchObject({
      tool: 'clipboard_read',
      rememberable: true,
      reason: 'first-use',
    });
    t.setAnswer(() => [true, true]); // 允许并记住本次运行
    const ok = await t.call('clipboard_read', {});
    expect(String(ok.data!.text)).toContain('trust="untrusted"');
    expect(String(ok.data!.text)).toContain('secret-token-123');
    const n = t.asks.length;
    expect((await t.call('clipboard_read', {})).ok).toBe(true);
    expect(t.asks.length).toBe(n); // 本次运行已记住
    // 设为每次询问 → 又要确认
    t.broker.setPolicy('clipboard_read', 'read', 'ask');
    await t.call('clipboard_read', {});
    expect(t.asks.length).toBe(n + 1);
  });

  it('clipboard write announces in the bubble; tainted turn forces confirm', async () => {
    const t = setup();
    t.setAnswer(() => [true, true]);
    const ctl = new AbortController();
    await t.call('clipboard_read', {}, ctl.signal);
    const before = t.asks.length;
    expect((await t.call('clipboard_write', { text: '你好' }, ctl.signal)).ok).toBe(true);
    expect(t.asks.length).toBe(before + 1);
    expect(t.asks.at(-1)!.reason).toBe('tainted');
    expect(t.clip()).toBe('你好');
    expect(t.said).toContain('已复制到剪贴板');
  });

  it('clipboard write failure stays inside the tool call', async () => {
    const t = setup();
    t.setAnswer(() => [true, true]);
    t.failWrite(new Error('clipboard unavailable'));
    const r = await t.call('clipboard_write', { text: '你好' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'internal_error', message: 'clipboard unavailable' });
    expect(t.clip()).toBe('secret-token-123');
    expect(t.said).not.toContain('已复制到剪贴板');
  });
});
