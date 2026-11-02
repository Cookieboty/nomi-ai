/**
 * E10 · 持续任务 · 新建 → 立即运行 → 结束 → 看板字段 → 删除（docs/design/persistent-tasks.md）
 *
 * 语义对齐：
 * - 真实内核跑在无界面宿主上，任务服务是内核里真实的 TaskService（存储、运行时、投递都是真的）；
 * - 对话窗口经契约 `tasks.*` 操作，内核在任务变化时推 `tasks.changed`；
 * - 断言：
 *   1. 新建的手动任务是 idle，授权按给的写进去，带上重要程度 / 类型；
 *   2. 「只发通知」的任务立即运行后结束（done），执行历史里有一次成功的执行；
 *   3. 改重要程度、清掉类型；授权里不合法的连接能力被拒（TASKS_BAD_GRANT）；
 *   4. 结束的任务可以删除，删除后列表里没有它；整个过程窗口收到 tasks.changed。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startE2eCore, type E2eCore } from '../helpers/headlessCore';

interface TaskView {
  id: string;
  status: string;
  priority?: string;
  category?: string;
  grant: { level: number };
}

describe('E10 · 持续任务的生命周期（契约 tasks.*）', () => {
  let core: E2eCore;

  beforeEach(async () => {
    core = await startE2eCore();
  });

  afterEach(async () => {
    await core.stop();
  });

  it('新建 → 立即运行 → 结束 → 改重要程度 → 删除', async () => {
    const { api } = core.openWindow();
    const changed: string[] = [];
    api.on('tasks.changed', (p) => changed.push((p as { id: string }).id));
    await core.settle();

    const created = (await api.tasks.create({
      title: 'e2e 提醒',
      goal: '提醒我喝水',
      trigger: { kind: 'manual' },
      executor: { kind: 'notify', text: '喝水' },
      grant: { level: 0, paths: [], connections: [] },
      priority: 'high',
      category: 'chore',
    })) as unknown as TaskView;
    expect(created).toMatchObject({ status: 'idle', priority: 'high', category: 'chore' });
    expect(created.grant.level).toBe(0);

    expect(await api.tasks.runNow({ id: created.id })).toMatchObject({ ok: true });
    let rec: { task: TaskView; attempts: { status: string }[] } | null = null;
    for (let i = 0; i < 100; i++) {
      rec = (await api.tasks.get({ id: created.id })) as unknown as typeof rec;
      if (rec?.task.status === 'done') break;
      await core.settle(20);
    }
    expect(rec?.task.status).toBe('done');
    expect(rec?.attempts.at(-1)?.status).toBe('succeeded');

    const updated = (await api.tasks.update({
      id: created.id,
      priority: 'urgent',
      category: null,
    })) as unknown as TaskView;
    expect(updated.priority).toBe('urgent');
    expect(updated.category).toBeUndefined();

    // 授权：对外能力要 L4，合并 / 发布永不授予
    await expect(
      api.tasks.create({
        title: 'bad',
        goal: 'g',
        trigger: { kind: 'manual' },
        executor: { kind: 'nomi', tools: ['read'] },
        grant: {
          level: 1,
          paths: [],
          connections: [
            { connectionId: 'conn_x', capabilities: ['github.comment'], resources: ['o/r'] },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'TASKS_BAD_GRANT' });

    expect(await api.tasks.remove({ id: created.id })).toBe(true);
    const list = (await api.tasks.list()) as unknown as { tasks: TaskView[] };
    expect(list.tasks.some((t) => t.id === created.id)).toBe(false);
    await core.settle();
    expect(changed).toContain(created.id);
  });
});
