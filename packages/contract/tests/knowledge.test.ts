/**
 * D4（knowledge）：kb / mem / sched / local / hub / ext 的过程与事件
 * （docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 */

import { describe, expect, it } from 'vitest';

import { appContract, knowledgeEvents, knowledgeProcedures } from '../src/app';
import { createTestClient } from '../src/testing';

const NAMESPACES = ['kb', 'mem', 'sched', 'local', 'hub', 'ext'];

describe('knowledge 契约', () => {
  it('过程名 / kind / surfaces / dangerous', () => {
    const table = Object.entries(knowledgeProcedures).map(([name, def]) => {
      const d = def as { kind: string; surfaces?: readonly string[]; dangerous?: boolean };
      const flags = d.dangerous ? ' dangerous' : '';
      return `${name} ${d.kind} ${d.surfaces?.join('|') ?? '*'}${flags}`;
    });
    expect(table).toMatchSnapshot();
    expect(Object.keys(knowledgeEvents)).toMatchSnapshot();
  });

  it('只用本域命名空间，驼峰、不带连字符', () => {
    for (const name of [...Object.keys(knowledgeProcedures), ...Object.keys(knowledgeEvents)]) {
      expect(NAMESPACES).toContain(name.split('.')[0]);
      expect(name).toMatch(/^[a-z]+\.[a-z][A-Za-z]*$/);
    }
  });

  it('旧通道都在 aiIPC 上：不限 surfaces；授权类过程是 dangerous', () => {
    const dangerous = Object.entries(knowledgeProcedures)
      .filter(([, d]) => (d as { dangerous?: boolean }).dangerous)
      .map(([n]) => n);
    expect(dangerous.sort()).toEqual([
      'ext.mcpConnect',
      'ext.mcpToggle',
      'ext.mcpUpsert',
      'kb.consentCloud',
      'local.offline',
    ]);
    for (const d of Object.values(knowledgeProcedures)) {
      expect((d as { surfaces?: unknown }).surfaces).toBeUndefined();
    }
  });

  it('schema 接受旧形状、拒绝错误值', () => {
    const p = appContract.procedures;
    expect(p['kb.toggleSource'].input.safeParse({ id: 's1', enabled: true }).success).toBe(true);
    expect(p['kb.toggleSource'].input.safeParse({ id: 's1', enabled: 'yes' }).success).toBe(false);
    expect(p['kb.test'].input.safeParse({ kind: 'rerank' }).success).toBe(true);
    expect(p['kb.test'].input.safeParse({ kind: 'chat' }).success).toBe(false);
    expect(p['mem.remove'].input.safeParse({ kind: 'fact', id: 'f1' }).success).toBe(true);
    expect(p['mem.remove'].input.safeParse({ kind: 'note', id: 'f1' }).success).toBe(false);
    expect(p['mem.export'].input.safeParse({ format: 'csv' }).success).toBe(false);
    expect(
      p['sched.upsertTask'].input.safeParse({
        name: '早报',
        prompt: 'x',
        repeat: { kind: 'weekly', days: [1, 3] },
      }).success,
    ).toBe(true);
    expect(p['sched.upsertTask'].input.safeParse({ repeat: { kind: 'yearly' } }).success).toBe(
      false,
    );
    expect(p['ext.migrateImport'].input.safeParse({ items: [{ key: 'a' }] }).success).toBe(true);
    expect(
      p['ext.migrateImport'].input.safeParse({ items: [{ key: 'a', action: 'merge' }] }).success,
    ).toBe(false);
    // 输出：looseObject 透传未知字段
    const src = { id: 's', kind: 'folder', addedAt: 1, enabled: true, extra: 1 };
    expect(p['kb.addFolder'].output.parse(src)).toEqual(src);
    expect(p['kb.addFolder'].output.parse(null)).toBeNull();
    expect(p['kb.addFolder'].output.safeParse({ id: 's', kind: 'url' }).success).toBe(false);
    // 事件
    expect(appContract.events['kb.changed'].safeParse(null).success).toBe(true);
    expect(appContract.events['kb.changed'].safeParse({}).success).toBe(false);
    expect(
      appContract.events['local.progress'].safeParse({ id: 'm', received: 1, total: 2 }).success,
    ).toBe(true);
    expect(appContract.events['mem.status'].safeParse({ busy: 'c1' }).success).toBe(false);
  });

  it('round-trip：具名入参、严格序列化、业务错误码、事件', async () => {
    const calls: unknown[] = [];
    const { api, router, close } = createTestClient(appContract, {
      'kb.toggleSource': (i) => {
        calls.push(i);
        return true;
      },
      'mem.list': () => ({
        episodes: [
          {
            id: 'e1',
            conversationId: 'c1',
            title: 't',
            summary: 's',
            keywords: ['k'],
            createdAt: 1,
            updatedAt: 2,
            messageCount: 4,
            pinned: false,
            edited: false,
            windowSig: 'sig',
          },
        ],
        facts: [],
      }),
      'sched.runTask': (_i, ctx) => ctx.fail('SCHED_BUSY', '任务正在运行'),
      'hub.export': (i) => {
        calls.push(i);
        return null;
      },
    });
    try {
      expect(await api.kb.toggleSource({ id: 's1', enabled: false })).toBe(true);
      const list = await api.mem.list({ filter: '' });
      expect(list.episodes[0]).toMatchObject({ id: 'e1', windowSig: 'sig' });
      await expect(api.sched.runTask({ id: 't1' })).rejects.toMatchObject({
        code: 'SCHED_BUSY',
        message: '任务正在运行',
      });
      expect(
        await api.hub.export({ include: ['memory'], conversations: { 'ai-chat:x': [1] } }),
      ).toBeNull();
      expect(calls).toEqual([
        { id: 's1', enabled: false },
        { include: ['memory'], conversations: { 'ai-chat:x': [1] } },
      ]);

      const got: unknown[] = [];
      const off = api.on('sched.result', (r) => got.push(r));
      await new Promise((r) => setTimeout(r, 0));
      router.events.publish('sched.result', {
        id: 'r1',
        taskId: 't1',
        name: 'n',
        at: 1,
        ok: true,
        text: 'hi',
      });
      await new Promise((r) => setTimeout(r, 0));
      off();
      expect(got).toEqual([{ id: 'r1', taskId: 't1', name: 'n', at: 1, ok: true, text: 'hi' }]);
    } finally {
      close();
    }
  });
});
