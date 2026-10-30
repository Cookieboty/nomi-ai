/**
 * P1b 的域划分（docs/design/core-host-decoupling.md §12「P1b 实施约定」）：
 * 五个域文件汇总进应用契约、名字互不重复；`createTestClient` 只实现关心的过程。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineContract, type ProcedureDef } from '../src';
import { APP_DOMAINS, aiEvents, aiProcedures, appContract } from '../src/app';
import { createTestClient, withMissingHandlers } from '../src/testing';

describe('appContract · 域', () => {
  it('五个域 D1..D5，各自的过程 / 事件都汇总进契约', () => {
    expect(Object.entries(APP_DOMAINS).map(([file, d]) => `${d.key}:${file}`)).toEqual([
      'D1:media',
      'D2:shell',
      'D3:coding',
      'D4:knowledge',
      'D5:mascot',
    ]);
    const procedures = new Set(Object.keys(appContract.procedures));
    const events = new Set(Object.keys(appContract.events));
    let pCount = Object.keys(aiProcedures).length;
    let eCount = Object.keys(aiEvents).length;
    for (const d of Object.values(APP_DOMAINS)) {
      for (const name of Object.keys(d.procedures)) expect(procedures.has(name)).toBe(true);
      for (const name of Object.keys(d.events)) expect(events.has(name)).toBe(true);
      pCount += Object.keys(d.procedures).length;
      eCount += Object.keys(d.events).length;
    }
    // 展开不能静默覆盖：总数 = 各部分之和
    expect(procedures.size).toBe(pCount);
    expect(events.size).toBe(eCount);
  });

  it('域里的过程不用 ai.* 命名空间（留给 AI 门面）', () => {
    for (const d of Object.values(APP_DOMAINS)) {
      for (const name of [...Object.keys(d.procedures), ...Object.keys(d.events)]) {
        expect(name.startsWith('ai.')).toBe(false);
      }
    }
  });
});

describe('testing · createTestClient', () => {
  const contract = defineContract({
    version: { major: 1, minor: 0 },
    procedures: {
      'demo.get': { kind: 'query', input: z.void(), output: z.number() },
      'demo.set': { kind: 'mutation', input: z.number(), output: z.void(), surfaces: ['chat'] },
      'demo.watch': { kind: 'stream', input: z.void(), chunk: z.number() },
    },
    events: { 'demo.changed': z.number() },
  });

  it('只实现关心的过程，其余以 NOT_FOUND 失败；事件经 router 推给订阅者', async () => {
    let value = 1;
    const { api, router, close } = createTestClient(
      contract,
      {
        'demo.get': () => value,
        'demo.set': (v) => {
          value = v;
        },
      },
      { caller: { surface: 'chat', trusted: true } },
    );
    try {
      expect(await api.demo.get()).toBe(1);
      await api.demo.set(5);
      expect(await api.demo.get()).toBe(5);
      await expect(api.demo.watch()[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      const got: number[] = [];
      const off = api.on('demo.changed', (v) => got.push(v));
      await new Promise((r) => setTimeout(r, 0));
      router.events.publish('demo.changed', 7);
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([7]);
      off();
    } finally {
      close();
    }
  });

  it('caller 走内置守卫：surfaces 不符时 FORBIDDEN', async () => {
    const { api, close } = createTestClient(
      contract,
      { 'demo.set': () => undefined },
      { caller: { surface: 'mascot', trusted: true } },
    );
    try {
      await expect(api.demo.set(1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      close();
    }
  });

  it('withMissingHandlers 给每个缺的过程补上桩', () => {
    const table = withMissingHandlers(contract, {}) as Record<string, unknown>;
    for (const name of Object.keys(contract.procedures as Record<string, ProcedureDef>)) {
      expect(typeof table[name]).toBe('function');
    }
  });
});
