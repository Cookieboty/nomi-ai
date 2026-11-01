jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TaskService } from '../../../src/tasks/TaskService';
import { createTaskTools, triggerOf } from '../../../src/tasks/tools';

const T0 = new Date(2026, 10, 2, 8, 30).getTime();

function setup(
  decision: 'allowed' | 'denied' = 'allowed',
  github: { id: string; label: string } | null = null,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-tools-'));
  const svc = new TaskService({
    root: dir,
    logger: { info: () => undefined, warn: () => undefined },
    events: { publish: () => undefined },
    notify: { notify: () => undefined },
    now: () => T0,
    setTimer: () => () => undefined,
  });
  const cards: { preview: string; force: { dialog: boolean } }[] = [];
  const tools = createTaskTools({
    tasks: svc,
    authorize: async (i) => {
      cards.push(i);
      return decision;
    },
    githubConnection: () => github,
    now: () => T0,
  });
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  return { svc, cards, tool, dir };
}

describe('task_propose / task_recall', () => {
  it('起草：弹授权卡片（强制确认），确认后才创建，记为 Nomi 起草、带来源对话', async () => {
    const h = setup();
    const r = (await h.tool('task_propose').execute(
      {
        title: '看 CI',
        goal: '每天看 o/r 的 CI，红了告诉我原因',
        when: { kind: 'daily', time: '09:00' },
        tools: ['read', 'web'],
      },
      { conversationId: 'conv_1' },
    )) as { ok: true; data: { id: string; created: boolean } };
    expect(r.ok).toBe(true);
    expect(h.cards[0]!.force).toEqual({ dialog: true });
    expect(h.cards[0]!.preview).toContain('每天 09:00');
    expect(h.cards[0]!.preview).toContain('只读');
    const rec = h.svc.get(r.data.id)!;
    expect(rec.task).toMatchObject({
      origin: { createdBy: 'nomi', conversationId: 'conv_1' },
      executor: { kind: 'nomi', tools: ['read', 'web'] },
      grant: { level: 1 },
      trigger: { kind: 'schedule', repeat: { kind: 'daily' } },
    });
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('用户拒绝就不创建；编程助手回调不能创建；跑命令要 L3', async () => {
    const h = setup('denied');
    const input = { title: 't', goal: 'g', when: { kind: 'manual' }, tools: ['shell'] };
    const r = await h.tool('task_propose').execute(input, {});
    expect(r).toMatchObject({ ok: false, error: { code: 'user_denied' } });
    expect(h.cards[0]!.preview).toContain('跑命令');
    expect(h.svc.list().tasks).toEqual([]);
    const cli = await h.tool('task_propose').execute(input, { callerTabId: 'tab_1' });
    expect(cli).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(h.cards).toHaveLength(1);
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('查询：给 id 返回目标、状态与最近一次结论；不给 id 列出最近的任务', async () => {
    const h = setup();
    const created = (await h.tool('task_propose').execute(
      {
        title: '提醒喝水',
        goal: '喝水',
        when: { kind: 'interval', minutes: 60 },
        executor: 'notify',
      },
      {},
    )) as { ok: true; data: { id: string } };
    const one = (await h.tool('task_recall').execute({ id: created.data.id }, {})) as {
      ok: true;
      data: Record<string, unknown>;
    };
    expect(one.data).toMatchObject({
      id: created.data.id,
      title: '提醒喝水',
      goal: '喝水',
      attempts: 0,
    });
    const all = (await h.tool('task_recall').execute({}, {})) as {
      ok: true;
      data: { tasks: unknown[] };
    };
    expect(all.data.tasks).toHaveLength(1);
    expect(await h.tool('task_recall').execute({ id: 'task_x' }, {})).toMatchObject({
      ok: false,
      error: { code: 'unknown_task' },
    });
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('带 GitHub 仓库：授权卡片列出仓库，授权里写入 github.read；没连 GitHub 时拒绝', async () => {
    const h = setup('allowed', { id: 'conn_1', label: 'GitHub · octo' });
    const r = (await h
      .tool('task_propose')
      .execute(
        { title: 'CI', goal: 'g', when: { kind: 'manual' }, github_repos: ['o/r'] },
        {},
      )) as { ok: true; data: { id: string } };
    expect(h.cards[0]!.preview).toContain('o/r');
    expect(h.svc.get(r.data.id)!.task.grant.connections).toEqual([
      { connectionId: 'conn_1', capabilities: ['github.read'], resources: ['o/r'] },
    ]);
    const none = setup();
    expect(
      await none
        .tool('task_propose')
        .execute({ title: 'CI', goal: 'g', when: { kind: 'manual' }, github_repos: ['o/r'] }, {}),
    ).toMatchObject({ ok: false, error: { code: 'no_connection' } });
    fs.rmSync(h.dir, { recursive: true, force: true });
    fs.rmSync(none.dir, { recursive: true, force: true });
  });

  it('何时 → 触发器：每天按本机时间；一次性时间要合法', () => {
    expect(triggerOf({ kind: 'daily', time: '09:15' }, T0)).toEqual({
      kind: 'schedule',
      at: new Date(2026, 10, 2, 9, 15).getTime(),
      repeat: { kind: 'daily' },
    });
    expect(triggerOf({ kind: 'weekly', days: [1, 5], time: '18:00' }, T0)).toMatchObject({
      repeat: { kind: 'weekly', days: [1, 5] },
    });
    expect(() => triggerOf({ kind: 'once', at: 'not a time' }, T0)).toThrow('invalid time');
  });

  it('每日费用预算：今天已花的钱达到上限，触发时先停下来问', () => {
    const h = setup();
    const t = h.svc.create({
      title: 't',
      goal: 'g',
      trigger: { kind: 'manual' },
      executor: { kind: 'nomi', tools: ['read'] },
      grant: { level: 1, paths: [], connections: [] },
      budget: { maxCostUsdPerDay: 0.5 },
    });
    const rec = h.svc.get(t.id)!;
    // 直接写入一条今天的执行记录（花了 0.6 美元）
    h.svc.store.save({
      task: rec.task,
      attempts: [
        {
          id: 'att_x',
          taskId: t.id,
          gen: 0,
          cause: { kind: 'manual' },
          snapshot: { grantVersion: 1 },
          status: 'succeeded',
          startedAt: T0 - 60_000,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6, costKnown: true },
        },
      ],
    });
    const fresh = new TaskService({
      root: h.dir,
      logger: { info: () => undefined, warn: () => undefined },
      events: { publish: () => undefined },
      notify: { notify: () => undefined },
      now: () => T0,
      setTimer: () => () => undefined,
    });
    fresh.start();
    expect(fresh.spentToday(t.id, T0)).toBeCloseTo(0.6);
    fresh.command(t.id, { type: 'runNow' });
    expect(fresh.get(t.id)!.task).toMatchObject({
      status: 'waiting_user',
      wait: { kind: 'budget' },
    });
    fs.rmSync(h.dir, { recursive: true, force: true });
  });
});
