import { afterEach, describe, expect, it } from 'vitest';

import {
  delegateAlias,
  delegateAliasPool,
  fleetAgentAliasId,
  fleetDelegatedPeers,
  MAX_EN_ALIAS_LEN,
  MAX_ZH_ALIAS_LEN,
  resetDelegateAliases,
  syncDelegateAliases,
  type DelegateAliasPeer,
} from '../src/utils/delegateAlias';

describe('delegateAlias', () => {
  afterEach(() => {
    resetDelegateAliases();
  });

  it('词库长度、字长约束、唯一性与角色名隔离满足全部不变量', () => {
    const zhPool = delegateAliasPool('zh-CN');
    const enPool = delegateAliasPool('en');
    expect(zhPool).toHaveLength(64);
    expect(enPool).toHaveLength(64);
    expect(new Set(zhPool).size).toBe(64);
    expect(new Set(enPool).size).toBe(64);

    for (const zh of zhPool) {
      expect([...zh].length).toBeGreaterThanOrEqual(2);
      expect([...zh].length).toBeLessThanOrEqual(MAX_ZH_ALIAS_LEN);
      expect(zh).not.toContain('诺米');
      expect(zh.toLowerCase()).not.toContain('nomi');
    }

    for (const en of enPool) {
      expect(en.length).toBeGreaterThanOrEqual(3);
      expect(en.length).toBeLessThanOrEqual(MAX_EN_ALIAS_LEN);
      expect(en.toLowerCase()).not.toContain('nomi');
      expect(en.toLowerCase()).not.toContain('nori');
    }
  });

  it('中文与英文词库一一对应，同一 id 在不同语言下返回对应名称并符合长度限制', () => {
    const zhPool = delegateAliasPool('zh-CN');
    const enPool = delegateAliasPool('en');
    const peers: DelegateAliasPeer[] = [
      { id: 'tab-claude-1', createdAt: 100, delegation: { by: 'nomi' } },
      { id: 'tab-claude-2', createdAt: 200, delegation: { by: 'nomi' } },
    ];
    syncDelegateAliases(peers);

    const zh1 = delegateAlias('tab-claude-1', { locale: 'zh-CN' });
    const zh2 = delegateAlias('tab-claude-2', { locale: 'zh-CN' });
    const en1 = delegateAlias('tab-claude-1', { locale: 'en' });
    const en2 = delegateAlias('tab-claude-2', { locale: 'en' });

    expect(zh1).not.toBe(zh2);
    expect(en1).not.toBe(en2);
    expect([...zh1].length).toBeLessThanOrEqual(MAX_ZH_ALIAS_LEN);
    expect([...zh2].length).toBeLessThanOrEqual(MAX_ZH_ALIAS_LEN);
    expect(en1.length).toBeLessThanOrEqual(MAX_EN_ALIAS_LEN);
    expect(en2.length).toBeLessThanOrEqual(MAX_EN_ALIAS_LEN);

    const idx1 = zhPool.indexOf(zh1);
    const idx2 = zhPool.indexOf(zh2);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(en1).toBe(enPool[idx1]);
    expect(en2).toBe(enPool[idx2]);
  });

  it('并发超过词库容量（100 个委派 CLI）时仍全部分配互不重复的短名且不超长度', () => {
    const peers: DelegateAliasPeer[] = Array.from({ length: 100 }, (_, i) => ({
      id: `delegate-task-${i}`,
      createdAt: 1000 + i,
      delegation: { by: 'nomi' },
    }));
    syncDelegateAliases(peers);

    const zhNames = peers.map((p) => delegateAlias(p.id, { locale: 'zh-CN' }));
    const enNames = peers.map((p) => delegateAlias(p.id, { locale: 'en' }));

    expect(new Set(zhNames).size).toBe(100);
    expect(new Set(enNames).size).toBe(100);
    for (const zh of zhNames) expect([...zh].length).toBeLessThanOrEqual(MAX_ZH_ALIAS_LEN);
    for (const en of enNames) expect(en.length).toBeLessThanOrEqual(MAX_EN_ALIAS_LEN);
  });

  it('关掉中间某几个标签后再同步，其余标签名字保持完全稳定，不会跳变', () => {
    const initial: DelegateAliasPeer[] = [
      { id: 'tab-a', createdAt: 1, delegation: { by: 'nomi' } },
      { id: 'tab-b', createdAt: 2, delegation: { by: 'nomi' } },
      { id: 'tab-c', createdAt: 3, delegation: { by: 'nomi' } },
    ];
    syncDelegateAliases(initial);
    const aBefore = delegateAlias('tab-a', { locale: 'zh-CN' });
    const cBefore = delegateAlias('tab-c', { locale: 'zh-CN' });

    syncDelegateAliases([initial[0]!, initial[2]!]);
    expect(delegateAlias('tab-a', { locale: 'zh-CN' })).toBe(aBefore);
    expect(delegateAlias('tab-c', { locale: 'zh-CN' })).toBe(cBefore);

    // 非委派普通标签不参与委派短名分配
    const mixed: DelegateAliasPeer[] = [
      { id: 'plain-tab', createdAt: 0 },
      initial[0]!,
      initial[2]!,
    ];
    syncDelegateAliases(mixed);
    expect(delegateAlias('tab-a', { locale: 'zh-CN' })).toBe(aBefore);
    expect(delegateAlias('tab-c', { locale: 'zh-CN' })).toBe(cBefore);
  });

  it('独立窗口场景：无论 peers 数组输入顺序如何，均稳定产生完全一致的名字映射', () => {
    const a: DelegateAliasPeer = { id: 'x-1', createdAt: 10, delegation: { by: 'nomi' } };
    const b: DelegateAliasPeer = { id: 'x-2', createdAt: 20, delegation: { by: 'nomi' } };
    const c: DelegateAliasPeer = { id: 'x-3', createdAt: 30, delegation: { by: 'nomi' } };

    syncDelegateAliases([a, b, c]);
    const mainWindowNames = [a, b, c].map((p) => delegateAlias(p.id, { locale: 'en' }));

    resetDelegateAliases();
    // 另一窗口传入不同顺序但同 createdAt / id
    syncDelegateAliases([c, a, b]);
    const detachedWindowNames = [a, b, c].map((p) => delegateAlias(p.id, { locale: 'en' }));

    expect(detachedWindowNames).toEqual(mainWindowNames);

    // 未提前调用 syncDelegateAliases，仅通过 peers 参数做纯读取也得到一致结果
    resetDelegateAliases();
    expect(delegateAlias('x-1', { peers: [c, b, a], locale: 'en' })).toBe(mainWindowNames[0]);
    expect(delegateAlias('x-2', { peers: [c, b, a], locale: 'en' })).toBe(mainWindowNames[1]);
    expect(delegateAlias('x-3', { peers: [c, b, a], locale: 'en' })).toBe(mainWindowNames[2]);
  });

  it('Agents 看板辅助函数仅识别受管委派 CLI 并提取 tabId / taskId', () => {
    expect(
      fleetAgentAliasId({
        scope: 'managed',
        kind: 'cli',
        origin: 'conversation',
        tabId: 'tab-1',
        taskId: 'task-1',
      }),
    ).toBe('tab-1');
    expect(
      fleetAgentAliasId({
        scope: 'managed',
        kind: 'cli',
        origin: 'task',
        taskId: 'task-only',
      }),
    ).toBe('task-only');
    expect(
      fleetAgentAliasId({
        scope: 'external',
        kind: 'cli',
        origin: 'terminal',
        tabId: 'ext-1',
      }),
    ).toBeUndefined();
    expect(
      fleetAgentAliasId({
        scope: 'managed',
        kind: 'cli',
        origin: 'workbench',
        tabId: 'wb-1',
      }),
    ).toBeUndefined();

    const peers = fleetDelegatedPeers([
      { scope: 'managed', kind: 'cli', origin: 'conversation', tabId: 't1' },
      { scope: 'managed', kind: 'nomi', origin: 'chat' },
      { scope: 'external', kind: 'cli', origin: 'terminal', tabId: 'ext' },
      { scope: 'managed', kind: 'cli', origin: 'task', taskId: 't2' },
    ]);
    expect(peers.map((p) => p.id)).toEqual(['t1', 't2']);
  });
});
