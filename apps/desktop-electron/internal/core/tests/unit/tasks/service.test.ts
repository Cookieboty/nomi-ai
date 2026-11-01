jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { legacyItems } from '../../../src/tasks/legacy';
import type { TaskExecutor } from '../../../src/tasks/TaskRuntime';
import { TaskService } from '../../../src/tasks/TaskService';

const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-svc-'));
  const notices: { title: string; text: string }[] = [];
  const events: { event: string; payload: unknown }[] = [];
  let now = T0;
  const timers: { at: number; fn: () => void }[] = [];
  const svc = new TaskService({
    root: dir,
    logger: { info: () => undefined, warn: () => undefined },
    events: { publish: (event, payload) => events.push({ event, payload }) },
    notify: { notify: (n) => notices.push({ title: n.title, text: n.text }) },
    legacy: {
      reminders: () => [
        { id: 'rb', text: '喝水', dueAt: T0 + 2, status: 'pending' },
        { id: 'ra', text: '开会', dueAt: T0 + 1, status: 'pending', repeat: { kind: 'daily' } },
        { id: 'rc', text: '已完成', dueAt: T0, status: 'done' },
      ],
      sched: () => [
        {
          id: 's1',
          name: '每日简报',
          enabled: true,
          nextRunAt: T0 + 5,
          repeat: { kind: 'daily' },
          lastStatus: 'ok',
        },
      ],
    },
    now: () => now,
    setTimer: (fn, ms) => {
      timers.push({ at: now + ms, fn });
      return () => undefined;
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.splice(0).filter((x) => x.at <= now)) t.fn();
  };
  return {
    dir,
    svc,
    notices,
    events,
    advance,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('TaskService', () => {
  it('通知任务：到点发通知，结果不再重复投递；文件落在 tasks 目录', () => {
    const h = setup();
    h.svc.start();
    const task = h.svc.create({
      title: '站起来走走',
      goal: '提醒我站起来',
      trigger: { kind: 'schedule', at: T0 + 60_000 },
      executor: { kind: 'notify', text: '该站起来走走了' },
      grant: { level: 0, paths: [], connections: [] },
    });
    h.advance(60_000);
    expect(h.notices).toEqual([{ title: '站起来走走', text: '该站起来走走了' }]);
    expect(h.svc.get(task.id)!.task.status).toBe('done');
    expect(fs.existsSync(path.join(h.dir, `${task.id}.json`))).toBe(true);
    expect(h.svc.journal(task.id).map((e) => e.t)).toContain('state');
    expect(h.events.every((e) => e.event === 'tasks.changed')).toBe(true);
    h.cleanup();
  });

  it('需要人 / 失败时投递；收件箱列出需要处理的任务', () => {
    const h = setup();
    let report: Parameters<TaskExecutor['start']>[0]['report'] | null = null;
    h.svc.registerExecutor('nomi', {
      prepare: (t) => ({ grantVersion: t.grant.version }),
      start: (ctx) => {
        report = ctx.report;
      },
      resume: () => undefined,
      stop: () => undefined,
    });
    h.svc.start();
    const a = h.svc.create({
      title: '看 CI',
      goal: 'g',
      trigger: { kind: 'manual' },
      executor: { kind: 'nomi', tools: ['read'] },
      grant: { level: 1, paths: [], connections: [] },
    });
    h.svc.command(a.id, { type: 'runNow' });
    report!.needsUser({ kind: 'approval', requestId: 'r', detail: '要跑 npm test' });
    expect(h.notices.at(-1)!.text).toContain('要跑 npm test');
    expect(h.svc.inbox().map((t) => t.id)).toEqual([a.id]);
    h.svc.command(a.id, { type: 'decide', requestId: 'r', approve: true });
    report!.failed({ code: 'executor_failed', message: '编译失败' });
    // 投递队列：30 秒内的第二条攒着，窗口结束再发
    h.advance(30_000);
    expect(h.notices.at(-1)!.text).toContain('编译失败');
    expect(h.svc.inbox().map((t) => t.status)).toEqual(['failed']);
    // 失败是结束态，可以删；运行中的不行
    h.svc.command(a.id, { type: 'runNow' });
    expect(h.svc.remove(a.id)).toBe(false);
    h.svc.command(a.id, { type: 'cancel' });
    expect(h.svc.remove(a.id)).toBe(true);
    h.cleanup();
  });

  it('改标题与定时：重算下一次运行时间', () => {
    const h = setup();
    const t = h.svc.create({
      title: 'a',
      goal: 'g',
      trigger: { kind: 'manual' },
      executor: { kind: 'notify', text: 'x' },
      grant: { level: 0, paths: [], connections: [] },
    });
    const u = h.svc.update(t.id, { title: 'b', trigger: { kind: 'schedule', at: T0 + 1000 } });
    expect(u).toMatchObject({ title: 'b', nextRunAt: T0 + 1000 });
    expect(h.svc.update('task_none', { title: 'x' })).toBeNull();
    h.cleanup();
  });

  it('旧的提醒 / 定时并入列表：只列待触发的提醒，按时间排', () => {
    const h = setup();
    expect(h.svc.list().legacy).toEqual(
      legacyItems(
        [
          { id: 'rb', text: '喝水', dueAt: T0 + 2, status: 'pending' },
          { id: 'ra', text: '开会', dueAt: T0 + 1, status: 'pending', repeat: { kind: 'daily' } },
        ],
        [
          {
            id: 's1',
            name: '每日简报',
            enabled: true,
            nextRunAt: T0 + 5,
            repeat: { kind: 'daily' },
            lastStatus: 'ok',
          },
        ],
      ),
    );
    expect(h.svc.list().legacy.map((x) => `${x.source}:${x.id}`)).toEqual([
      'reminder:ra',
      'reminder:rb',
      'schedule:s1',
    ]);
    h.cleanup();
  });
});
