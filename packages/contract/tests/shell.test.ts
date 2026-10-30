/**
 * D2 · 应用外壳（`contract/src/app/shell.ts`）：
 * - 过程表快照：名字、kind、surfaces、dangerous 不漂移；事件名；
 * - schema：合法值通过、不合法值拒绝、loose 字段透传；
 * - 端到端：createTestClient（strict 序列化）跑通 query / mutation / 事件，surfaces / dangerous 由守卫判定。
 */

import { describe, expect, it } from 'vitest';

import type { ProcedureDef } from '../src';
import { appContract, shellEvents, shellProcedures } from '../src/app';
import * as S from '../src/app/shell/schemas';
import { createTestClient } from '../src/testing';

const tick = () => new Promise((r) => setTimeout(r, 0));

const flags = (d: ProcedureDef) =>
  [
    d.kind,
    ...(d.surfaces ? [`surfaces=${d.surfaces.join('|')}`] : []),
    ...(d.dangerous ? ['dangerous'] : []),
  ].join(' ');

describe('shell · 过程表', () => {
  it('名字 / kind / surfaces / dangerous', () => {
    const table = Object.fromEntries(
      Object.entries(shellProcedures as unknown as Record<string, ProcedureDef>).map(([n, d]) => [
        n,
        flags(d),
      ]),
    );
    expect(table).toEqual({
      'theme.get': 'query',
      'theme.set': 'mutation',
      'locale.get': 'query',
      'locale.set': 'mutation',
      'locale.dict': 'query',
      'startup.get': 'query',
      'startup.set': 'mutation',
      'onboarding.get': 'query',
      'onboarding.complete': 'mutation',
      'onboarding.reopen': 'mutation',
      'onboarding.mascot': 'mutation',
      'onboarding.profile': 'query',
      'onboarding.setProfile': 'mutation',
      'providers.presets': 'query',
      'providers.meta': 'query',
      'providers.state': 'query',
      'providers.setActive': 'mutation',
      'gateway.state': 'query',
      'gateway.nomiContext': 'query',
      'gateway.detect': 'mutation',
      'gateway.retry': 'mutation',
      'gateway.upsertProvider': 'mutation',
      'gateway.removeProvider': 'mutation',
      'gateway.setAssignment': 'mutation',
      'gateway.setOptions': 'mutation',
      'gateway.resetToken': 'mutation',
      'gateway.clearLearned': 'mutation',
      'gateway.confirmPrivateHost': 'mutation dangerous',
      'gateway.privacyPreview': 'query',
      'gateway.privacyLog': 'query',
      'gateway.privacyClearLog': 'mutation',
      'gateway.privacyAddAllow': 'mutation',
      'gateway.privacyRemoveAllow': 'mutation',
      'gateway.privacyAddSecret': 'mutation',
      'gateway.privacyRemoveSecret': 'mutation',
      'gateway.privacySetAction': 'mutation',
      'gateway.terminalState': 'query',
      'gateway.terminalSet': 'mutation',
      'usage.state': 'query',
      'usage.setSettings': 'mutation',
      'usage.query': 'query',
      'usage.details': 'query',
      'usage.heatmap': 'query',
      'usage.csv': 'query',
      'usage.clear': 'mutation',
      'usage.scan': 'mutation',
      'usage.endpoint': 'query',
      'usage.priceSync': 'mutation',
      'usage.quota': 'query',
      'usage.quotaRefresh': 'mutation',
      'usage.quotaHook': 'query',
      'usage.quotaHookSet': 'mutation',
      'quality.query': 'query',
      'quality.series': 'query',
      'quality.requests': 'query',
      'quality.facets': 'query',
      'quality.getSettings': 'query',
      'quality.setSettings': 'mutation',
      'quality.clear': 'mutation',
      'quality.exportCsv': 'mutation',
      'updates.get': 'query',
      'updates.check': 'mutation',
      'updates.download': 'mutation',
      'updates.install': 'mutation',
      'updates.setAutoCheck': 'mutation',
      'diagnostics.get': 'query surfaces=chat',
      'diagnostics.set': 'mutation surfaces=chat',
      'diagnostics.openFolder': 'mutation surfaces=chat',
      'diagnostics.export': 'mutation surfaces=chat',
      'appIcon.get': 'query surfaces=chat',
      'appIcon.set': 'mutation surfaces=chat',
    });
  });

  it('事件名', () => {
    expect(Object.keys(shellEvents)).toEqual([
      'theme.changed',
      'locale.changed',
      'startup.changed',
      'onboarding.show',
      'onboarding.profileChanged',
      'providers.changed',
      'providers.openPanel',
      'gateway.changed',
      'usage.changed',
      'quality.changed',
      'updates.changed',
    ]);
  });

  it('只用 D2 的命名空间，都汇总进应用契约', () => {
    const ns = new Set([
      'theme',
      'locale',
      'startup',
      'onboarding',
      'providers',
      'gateway',
      'usage',
      'quality',
      'updates',
      'diagnostics',
      'appIcon',
    ]);
    for (const name of [...Object.keys(shellProcedures), ...Object.keys(shellEvents)]) {
      expect(ns.has(name.split('.')[0]!)).toBe(true);
      expect(name).toMatch(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/);
    }
    for (const name of Object.keys(shellProcedures))
      expect(appContract.procedures).toHaveProperty([name]);
    for (const name of Object.keys(shellEvents)) expect(appContract.events).toHaveProperty([name]);
  });
});

describe('shell · schema', () => {
  it('主题 / 语言：已知值通过，未知值拒绝；旧 id 交给主进程归一', () => {
    expect(S.ThemeState.safeParse({ pref: 'system', resolved: 'graphite' }).success).toBe(true);
    expect(S.ThemeState.safeParse({ pref: 'paper', resolved: 'cream' }).success).toBe(false);
    expect(S.ThemeSetInput.safeParse({ pref: 'paper' }).success).toBe(true);
    expect(S.ThemeSetInput.safeParse('ink').success).toBe(false);
    expect(S.LocaleState.safeParse({ pref: 'system', locale: 'en' }).success).toBe(true);
    expect(S.LocaleState.safeParse({ pref: 'fr', locale: 'fr' }).success).toBe(false);
  });

  it('启动设置：部分更新；showMascot 必须是布尔', () => {
    expect(S.StartupPatch.safeParse({ showMascot: false }).success).toBe(true);
    expect(S.StartupPatch.safeParse({ showMascot: 'no' }).success).toBe(false);
    expect(
      S.StartupState.safeParse({ defaultView: 'main', closeMain: 'quit', showMascot: true })
        .success,
    ).toBe(true);
    expect(
      S.StartupState.safeParse({ defaultView: 'desk', closeMain: 'quit', showMascot: true })
        .success,
    ).toBe(false);
  });

  it('引导转发给桌面角色的指令只开放 say / gesture / reply，且只有语义名', () => {
    expect(
      S.OnboardingMascotCmd.safeParse({ type: 'say', text: 'hi', gesture: 'wave' }).success,
    ).toBe(true);
    expect(S.OnboardingMascotCmd.safeParse({ type: 'gesture', name: 'nod' }).success).toBe(true);
    expect(S.OnboardingMascotCmd.safeParse({ type: 'reply', phase: 'waiting' }).success).toBe(true);
    expect(S.OnboardingMascotCmd.safeParse({ type: 'motion', name: 'nod' }).success).toBe(false);
    expect(S.OnboardingMascotCmd.safeParse({ type: 'gesture', name: 'think-on' }).success).toBe(
      false,
    );
    expect(S.OnboardingMascotCmd.safeParse({ type: 'open-panel', panel: 'x' }).success).toBe(false);
  });

  it('网关：状态的未知字段透传，入参类型不对拒绝', () => {
    const state = {
      status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
      providers: [
        {
          id: 'p',
          name: 'P',
          enabled: true,
          urls: { chat: 'https://x' },
          keys: [{ id: 'k', masked: 'sk-…1', enabled: true, decryptable: true }],
          models: [{ id: 'm', enabled: true, effective: { ctx: 1, maxOutput: 1 } }],
          source: 'user',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      clients: { nomi: { models: { main: 'p/m' } } },
      allowedPrivateHosts: [],
      port: 1,
      privacy: { strict: false },
      catalog: { models: 1, version: 'v', synced: false },
    };
    const r = S.GatewayState.safeParse(state);
    expect(r.success).toBe(true);
    expect((r.data as typeof state).catalog).toEqual(state.catalog);
    expect((r.data as typeof state).providers[0]!.models[0]!.effective).toEqual({
      ctx: 1,
      maxOutput: 1,
    });
    expect(S.GatewayState.safeParse({ ...state, status: { state: 'weird' } }).success).toBe(false);
    expect(S.GatewayProviderInput.safeParse({ name: 'x', urls: {} }).success).toBe(true);
    expect(S.GatewayProviderInput.safeParse({ urls: {} }).success).toBe(false);
    expect(
      S.GatewayProviderInput.safeParse({ name: 'x', urls: {}, newKeys: [{ value: 1 }] }).success,
    ).toBe(false);
    expect(S.PrivacyAllowInput.safeParse({ value: 'secret' }).success).toBe(true);
    expect(S.PrivacyAllowInput.safeParse({ tag: 't', kind: 'k', len: 3, head: 'a' }).success).toBe(
      true,
    );
    expect(S.PrivacyAllowInput.safeParse({ tag: 't' }).success).toBe(false);
    expect(S.TerminalSetInput.safeParse({ enabled: 'yes' }).success).toBe(false);
  });

  it('用量 / 质量：查询参数与结果', () => {
    expect(S.UsageDetailQuery.safeParse({}).success).toBe(true);
    expect(S.UsageDetailQuery.safeParse({ dir: 'sideways' }).success).toBe(false);
    expect(S.UsageRangeId.safeParse('30d').success).toBe(true);
    expect(S.UsageRangeId.safeParse('1y').success).toBe(false);
    expect(S.QualityQuery.safeParse({ from: 0, to: 1, groupBy: 'model' }).success).toBe(true);
    expect(S.QualityQuery.safeParse({ from: '0', to: 1 }).success).toBe(false);
    expect(
      S.QualitySeries.safeParse({
        buckets: [1],
        series: [{ key: 'a', label: 'A', values: [null, 1] }],
      }).success,
    ).toBe(true);
  });

  it('更新状态：releaseName 可为 null；未知状态拒绝', () => {
    const base = { status: 'available', currentVersion: '2.0.5', autoCheck: true };
    expect(
      S.UpdateState.safeParse({ ...base, releaseName: null, releaseNotes: null }).success,
    ).toBe(true);
    expect(S.UpdateState.safeParse({ ...base, status: 'paused' }).success).toBe(false);
  });
});

describe('shell · 端到端（strict 序列化）', () => {
  it('query / mutation：入参打包、结果原样（含未知字段）', async () => {
    const seen: unknown[] = [];
    const { api, close } = createTestClient(
      appContract,
      {
        'theme.set': ({ pref }) => {
          seen.push(pref);
          return { pref: 'ink', resolved: 'ink' };
        },
        'startup.get': () => ({
          defaultView: 'main',
          closeMain: 'hide',
          showMascot: false,
          extra: 1,
        }),
        'gateway.setAssignment': (i) => {
          seen.push(i);
        },
        'usage.quotaRefresh': (i) => {
          seen.push(i);
          return { entries: [], tools: {} };
        },
        'locale.dict': () => ({ 'ui.a': 'A' }),
      },
      { caller: { surface: 'chat', trusted: true } },
    );
    try {
      expect(await api.theme.set({ pref: 'ink' })).toEqual({ pref: 'ink', resolved: 'ink' });
      expect(await api.startup.get()).toEqual({
        defaultView: 'main',
        closeMain: 'hide',
        showMascot: false,
        extra: 1,
      });
      await api.gateway.setAssignment({ client: 'nomi', patch: { models: { main: null } } });
      expect(await api.usage.quotaRefresh({})).toEqual({ entries: [], tools: {} });
      expect(await api.locale.dict()).toEqual({ 'ui.a': 'A' });
      expect(seen).toEqual(['ink', { client: 'nomi', patch: { models: { main: null } } }, {}]);
    } finally {
      close();
    }
  });

  it('只在对话窗口的过程：桌面角色窗口调用 FORBIDDEN', async () => {
    const handlers = {
      'diagnostics.get': () => ({
        enabled: true,
        forced: false,
        saveLogs: true,
        dir: '/tmp',
        bodyTrace: false,
      }),
      'appIcon.set': () => 'ink' as const,
      'updates.get': () => ({ status: 'idle' as const, currentVersion: '1', autoCheck: true }),
    };
    const mascot = createTestClient(appContract, handlers, {
      caller: { surface: 'mascot', trusted: true },
    });
    const chat = createTestClient(appContract, handlers, {
      caller: { surface: 'chat', trusted: true },
    });
    try {
      await expect(mascot.api.diagnostics.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(mascot.api.appIcon.set({ variant: 'ink' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // updates 两个窗口都有
      expect(await mascot.api.updates.get()).toMatchObject({ status: 'idle' });
      expect(await chat.api.diagnostics.get()).toMatchObject({ dir: '/tmp' });
      expect(await chat.api.appIcon.set({ variant: 'ink' })).toBe('ink');
    } finally {
      mascot.close();
      chat.close();
    }
  });

  it('dangerous：不可信调用者不能确认私有地址', async () => {
    const handlers = { 'gateway.confirmPrivateHost': () => undefined };
    const untrusted = createTestClient(appContract, handlers, {
      caller: { surface: 'chat', trusted: false },
    });
    const trusted = createTestClient(appContract, handlers, {
      caller: { surface: 'chat', trusted: true },
    });
    try {
      await expect(
        untrusted.api.gateway.confirmPrivateHost({ hostPort: '127.0.0.1:11434' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        trusted.api.gateway.confirmPrivateHost({ hostPort: '127.0.0.1:11434' }),
      ).resolves.toBeUndefined();
    } finally {
      untrusted.close();
      trusted.close();
    }
  });

  it('事件：null 事件与状态事件推给订阅者', async () => {
    const { api, router, close } = createTestClient(appContract, {});
    try {
      const got: unknown[] = [];
      const off1 = api.on('gateway.changed', (p) => got.push(['gateway', p]));
      const off2 = api.on('updates.changed', (p) => got.push(['updates', p.status]));
      await tick();
      router.events.publish('gateway.changed', null);
      router.events.publish('updates.changed', {
        status: 'downloaded',
        currentVersion: '1',
        autoCheck: false,
      });
      await tick();
      expect(got).toEqual([
        ['gateway', null],
        ['updates', 'downloaded'],
      ]);
      off1();
      off2();
    } finally {
      close();
    }
  });
});
