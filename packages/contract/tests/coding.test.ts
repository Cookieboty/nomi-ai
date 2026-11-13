/**
 * D3 · 编程助手（app/coding.ts）：过程名 / kind / surfaces / dangerous 的快照、schema 的接受与拒绝、
 * 经 in-process 传输（strict 序列化）的往返。
 */

import { describe, expect, it } from 'vitest';

import { canSubscribe } from '../src';
import { appContract, codingEvents, codingProcedures } from '../src/app';
import { createTestClient } from '../src/testing';

type Def = { kind: string; surfaces?: readonly string[]; dangerous?: boolean };

describe('appContract · D3 coding', () => {
  it('过程表快照：名字、kind、surfaces、dangerous', () => {
    const table = Object.entries(codingProcedures as Record<string, Def>).map(
      ([name, d]) =>
        `${name} ${d.kind}${d.surfaces ? ` [${d.surfaces.join(',')}]` : ''}${d.dangerous ? ' dangerous' : ''}`,
    );
    expect(table).toMatchSnapshot();
    expect(Object.keys(codingEvents)).toMatchSnapshot();
  });

  it('预览过程仅允许 chat，旧过程保留原有 surfaces 与危险操作边界', () => {
    const ns = new Set([
      'project',
      'harness',
      'cli',
      'cliAccount',
      'cliUpdate',
      'delegate',
      'agents',
      'fleet',
      'history',
    ]);
    for (const name of [...Object.keys(codingProcedures), ...Object.keys(codingEvents)]) {
      expect(ns.has(name.split('.')[0]!)).toBe(true);
      expect(name).not.toMatch(/-/);
    }
    for (const [name, d] of Object.entries(codingProcedures as Record<string, Def>)) {
      if (name.startsWith('harness.preview')) expect(d.surfaces).toEqual(['chat']);
      else expect(d.surfaces).toBeUndefined();
    }
    const dangerous = Object.entries(codingProcedures as Record<string, Def>)
      .filter(([, d]) => d.dangerous)
      .map(([n]) => n)
      .sort();
    expect(dangerous).toEqual([
      'delegate.dispatch',
      'fleet.closeIdle',
      'fleet.pause',
      'fleet.resume',
      'fleet.setAutoPause',
      'fleet.setPolicy',
      'harness.geminiTrustFolder',
      'harness.previewExternal',
      'harness.previewListDirectory',
      'harness.previewOpen',
      'harness.previewRenew',
      'harness.previewSave',
      'harness.replyApprovePlan',
      'harness.replyPermission',
      'harness.sandboxReply',
      'harness.tabPermissionMode',
      'history.deleteTab',
      'project.create',
      'project.update',
    ]);
  });

  it('预览契约拒绝桌面角色窗口与不可信写入，保存必须带完整修订', async () => {
    for (const caller of [
      { surface: 'mascot' as const, trusted: true },
      { surface: 'chat' as const, trusted: false },
    ]) {
      const { api, close } = createTestClient(
        appContract,
        {
          'harness.previewOpen': () => ({ ok: true, content: 'private' }),
          'harness.previewSave': () => ({ ok: true }),
        },
        { caller },
      );
      try {
        await expect(
          api.harness.previewOpen({ cwd: '/work', path: 'private.md' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          api.harness.previewSave({
            url: '/__nomi/preview/token',
            revision: 'a'.repeat(64),
            content: 'edit',
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      } finally {
        close();
      }
    }
    expect(
      codingProcedures['harness.previewSave'].input.safeParse({
        url: '/__nomi/preview/token',
        revision: 'stale',
        content: 'edit',
      }).success,
    ).toBe(false);
  });

  it('schema：输入严格（具名对象），输出 loose（未知字段透传）', () => {
    const p = codingProcedures;
    expect(
      p['harness.replyApprovePlan'].input.safeParse({
        tabId: 't',
        requestId: 'r',
        choice: 'manual',
      }).success,
    ).toBe(true);
    expect(
      p['harness.replyApprovePlan'].input.safeParse({ tabId: 't', requestId: 'r', choice: 'yes' })
        .success,
    ).toBe(false);
    expect(p['harness.tabSend'].input.safeParse({ id: 't', prompt: 1 }).success).toBe(false);
    expect(p['harness.tabAccount'].input.safeParse({ id: 't', accountId: null }).success).toBe(
      true,
    );
    expect(p['harness.gitStage'].input.safeParse({ cwd: '/w', paths: 'a' }).success).toBe(false);
    expect(p['history.list'].input.safeParse({ backend: 'claude' }).success).toBe(true);

    const tab = {
      id: 't',
      title: 'T',
      backend: 'claude',
      cwd: '/w',
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: 1,
      updatedAt: 2,
      modelOverride: 'x',
    };
    expect(p['harness.tabRename'].output.parse(tab)).toEqual(tab);
    expect(p['harness.tabRename'].output.safeParse({ ...tab, unread: '0' }).success).toBe(false);
    expect(codingEvents['cliAccount.changed'].safeParse(null).success).toBe(true);
    expect(codingEvents['cliAccount.changed'].safeParse({}).success).toBe(false);
    expect(
      codingEvents['harness.events'].safeParse([{ tabId: 't', type: 'text-delta', text: 'hi' }])
        .success,
    ).toBe(true);
  });

  it('往返：经 appContract 的 in-process 传输（strict 序列化），事件推给订阅者', async () => {
    const tabsState = { tabs: [], activeTabId: 'main', running: 0, queued: 0, codexNetwork: true };
    const { api, router, close } = createTestClient(
      appContract,
      {
        'harness.tabs': () => tabsState,
        'harness.tabSend': ({ id, prompt }) => ({ text: `${id}:${prompt}`, sessionId: null }),
        'cliAccount.remove': (_input, ctx) => ctx.fail('ACCOUNT_UNKNOWN_LIVE', 'unknown live'),
        'history.list': ({ backend, options }) => ({
          items: [{ key: `${backend}:1`, backend, sessionId: '1', title: 'x' }],
          nextOffset: options?.offset ?? null,
          hasMore: false,
        }),
      },
      { caller: { surface: 'chat', trusted: true } },
    );
    try {
      expect(await api.harness.tabs()).toEqual(tabsState);
      expect(await api.harness.tabSend({ id: 't', prompt: 'hi' })).toEqual({
        text: 't:hi',
        sessionId: null,
      });
      await expect(api.cliAccount.remove({ id: 'a' })).rejects.toMatchObject({
        code: 'ACCOUNT_UNKNOWN_LIVE',
      });
      expect(await api.history.list({ backend: 'codex', options: { offset: 20 } })).toMatchObject({
        items: [{ key: 'codex:1', title: 'x' }],
        nextOffset: 20,
      });

      const got: unknown[] = [];
      const off = api.on('harness.tabsChanged', (s) => got.push(s));
      const offNull = api.on('agents.changed', (s) => got.push(s));
      await new Promise((r) => setTimeout(r, 0));
      router.events.publish('harness.tabsChanged', tabsState);
      router.events.publish('agents.changed', null);
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([tabsState, null]);
      off();
      offNull();
      // 编程助手的会话内容只推给对话窗口（契约 eventSurfaces）
      expect(canSubscribe(appContract, 'harness.tabsChanged', 'mascot')).toBe(false);
      expect(canSubscribe(appContract, 'agents.changed', 'mascot')).toBe(true);
    } finally {
      close();
    }
  });
});
