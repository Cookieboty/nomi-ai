/**
 * D2（host/contract/shell.ts）：theme / locale / startup / onboarding / providers / gateway / usage /
 * quality / updates / diagnostics / appIcon 的处理函数委派给服务、服务缺失时 UNAVAILABLE、
 * 只在对话窗口的过程拒绝看板娘、dangerous 过程拒绝不可信调用者、旧通道桥接成契约事件、
 * 供应商变化经应用事件总线发出。
 */

import { createClient } from '@nomi-ai/contract';
import { createInProcessServer } from '@nomi-ai/contract/testing';
import { createRecordingAppEvents } from '@nomi-ai/core/core/appEvents';
import type { HostPorts } from '@nomi-ai/host-ports';

import {
  APP_EVENT_BRIDGE,
  createAppRouter,
  createContractEventBridge,
  createContractServices,
  type ContractDeps,
  type ContractServices,
} from '../../../../src/host/contract';
import { PROVIDERS_CHANGED, shellEventBridge } from '../../../../src/host/contract/shell';

jest.mock('../../../../src/core/appIcon', () => ({
  appIconState: jest.fn(() => ({
    variant: 'sunset',
    platform: 'darwin',
    previews: { sunset: 'data:a', cream: 'data:b', ink: 'data:c' },
  })),
  setIconVariant: jest.fn((v: unknown) => (v === 'ink' ? 'ink' : 'sunset')),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appIcon = require('../../../../src/core/appIcon') as {
  appIconState: jest.Mock;
  setIconVariant: jest.Mock;
};

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const theme = { pref: 'ink', resolved: 'ink' };
const startup = { defaultView: 'mascot', closeMain: 'hide', showMascot: true };
const update = { status: 'idle', currentVersion: '2.0.5', autoCheck: true };
const gatewayState = {
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [],
  clients: {},
  allowedPrivateHosts: [],
  port: 1,
  strictParams: false,
};
const usageState = {
  settings: { enabled: true, currency: 'USD' },
  detected: [],
  records: 0,
  lastScanAt: 0,
  pricing: { date: '2026-10-01', builtin: [] },
};
const providerState = { providers: [], envProviders: [], routes: {}, roles: ['chat'] };

function fakes() {
  let providersChanged: (() => void) | undefined;
  return {
    theme: { get: jest.fn(() => theme), set: jest.fn(() => theme) },
    locale: {
      get: jest.fn(() => ({ pref: 'system', locale: 'en' })),
      set: jest.fn(() => ({ pref: 'en', locale: 'en' })),
      dict: jest.fn(() => ({ 'ui.a': 'A' })),
    },
    startup: { get: jest.fn(() => startup), set: jest.fn(async () => startup) },
    onboarding: {
      get: jest.fn(() => ({ done: true })),
      complete: jest.fn(() => ({ done: true, skipped: true })),
      reopen: jest.fn(async () => ({ done: false })),
      mascot: jest.fn(() => true),
      profile: jest.fn(() => ({ role: null, interests: [] })),
      setProfile: jest.fn(() => ({ role: 'developer', interests: [] })),
    },
    gateway: {
      state: jest.fn(() => gatewayState),
      setAssignmentFor: jest.fn(),
      resetTokenFor: jest.fn(() => {
        throw new Error('未知客户端');
      }),
      confirmPrivateHost: jest.fn(),
      retry: jest.fn(),
      previewPrivacy: jest.fn(() => ({ text: '***', hits: [] })),
      clearPrivacyLog: jest.fn(async () => undefined),
      setPrivacyAction: jest.fn(() => gatewayState),
    },
    terminal: {
      state: jest.fn(),
      set: jest.fn(() => ({
        enabled: true,
        pathAdded: false,
        binDir: '/b',
        rcFiles: [],
        pathSupported: true,
        commands: [],
      })),
    },
    usage: {
      readState: jest.fn(async () => usageState),
      readQuery: jest.fn(),
      readCsv: jest.fn(async () => 'a,b'),
      refreshQuota: jest.fn(async () => ({ entries: [], tools: {} })),
      setQuotaHook: jest.fn(() => ({
        supported: true,
        enabled: true,
        hadOwnStatusLine: false,
        hasSnapshot: false,
      })),
      clearWithState: jest.fn(() => usageState),
    },
    quality: {
      query: jest.fn(() => ({ total: { key: 'all', label: 'All' }, groups: [], minSamples: 5 })),
      clear: jest.fn(async () => undefined),
      exportCsv: jest.fn(async () => ({ ok: false, rows: 0 })),
    },
    updates: {
      getState: jest.fn(() => update),
      check: jest.fn(async () => ({ ...update, status: 'checking' })),
      setAutoCheck: jest.fn(),
    },
    diagnostics: {
      view: jest.fn(() => ({
        enabled: true,
        forced: false,
        saveLogs: true,
        dir: '/logs',
        bodyTrace: true,
      })),
      openLogFolder: jest.fn(async () => true),
    },
    providers: {
      presets: jest.fn(() => [{ id: 'deepseek', name: 'DeepSeek' }]),
      meta: jest.fn(() => ({ categories: {}, protocols: {} })),
      state: jest.fn(() => providerState),
      setActive: jest.fn(() => {
        throw new Error('bad key sk-abcdefghijklmnopqrstuvwxyz');
      }),
      onChange: jest.fn((fn: () => void) => {
        providersChanged = fn;
        return () => undefined;
      }),
    },
    fireProvidersChanged: () => providersChanged?.(),
  };
}

function setup(
  opts: { surface?: 'chat' | 'mascot'; trusted?: boolean; withServices?: boolean } = {},
) {
  const f = fakes();
  const services: ContractServices = createContractServices();
  if (opts.withServices !== false) {
    Object.assign(services, {
      theme: f.theme,
      locale: f.locale,
      startup: f.startup,
      onboarding: f.onboarding,
      gateway: f.gateway,
      terminal: f.terminal,
      usage: f.usage,
      quality: f.quality,
      updates: f.updates,
      diagnostics: f.diagnostics,
      aiRuntime: { providers: f.providers },
    });
  }
  const events = createRecordingAppEvents();
  const deps: ContractDeps = { services, ports: {} as HostPorts, events, logger };
  const app = createAppRouter({ deps });
  const server = createInProcessServer();
  const stop = server.serve(app.router as never);
  const transport = server.connect({
    surface: opts.surface ?? 'chat',
    trusted: opts.trusted ?? true,
  });
  const api = createClient(app.router.contract, transport, { handshake: 'off' });
  return {
    f,
    api,
    events,
    close: () => {
      transport.disconnect();
      stop();
      app.dispose();
    },
  };
}

describe('host/contract · shell', () => {
  beforeEach(() => jest.clearAllMocks());

  it('主题 / 语言 / 启动 / 引导：入参解包后委派', async () => {
    const { api, f, close } = setup();
    try {
      expect(await api.theme.set({ pref: 'paper' })).toEqual(theme);
      expect(f.theme.set).toHaveBeenCalledWith('paper');
      expect(await api.locale.set({ pref: 'en' })).toEqual({ pref: 'en', locale: 'en' });
      expect(f.locale.set).toHaveBeenCalledWith('en');
      expect(await api.locale.dict()).toEqual({ 'ui.a': 'A' });
      await api.startup.set({ showMascot: false });
      expect(f.startup.set).toHaveBeenCalledWith({ showMascot: false });
      await api.onboarding.complete({ skipped: true });
      expect(f.onboarding.complete).toHaveBeenCalledWith(true);
      await api.onboarding.complete({});
      expect(f.onboarding.complete).toHaveBeenLastCalledWith(false);
      expect(await api.onboarding.mascot({ type: 'motion', name: 'nod' })).toBe(true);
      expect(f.onboarding.mascot).toHaveBeenCalledWith({ type: 'motion', name: 'nod' });
      await api.onboarding.setProfile({ role: 'developer', interests: [] });
      expect(f.onboarding.setProfile).toHaveBeenCalledWith({ role: 'developer', interests: [] });
    } finally {
      close();
    }
  });

  it('网关 / 终端命令：委派，服务抛错原样带回 message', async () => {
    const { api, f, close } = setup();
    try {
      expect(await api.gateway.state()).toMatchObject({ port: 1, strictParams: false });
      await api.gateway.setAssignment({ client: 'nomi', patch: { models: { main: 'p/m' } } });
      expect(f.gateway.setAssignmentFor).toHaveBeenCalledWith('nomi', { models: { main: 'p/m' } });
      await expect(api.gateway.resetToken({ client: 'nope' })).rejects.toMatchObject({
        code: 'INTERNAL',
        message: '未知客户端',
      });
      await api.gateway.retry();
      expect(f.gateway.retry).toHaveBeenCalled();
      expect(await api.gateway.privacyPreview({ text: 'sk-1' })).toEqual({ text: '***', hits: [] });
      expect(f.gateway.previewPrivacy).toHaveBeenCalledWith('sk-1');
      await api.gateway.privacyClearLog();
      expect(f.gateway.clearPrivacyLog).toHaveBeenCalled();
      await api.gateway.privacySetAction({ kind: 'aws', action: 'block' });
      expect(f.gateway.setPrivacyAction).toHaveBeenCalledWith('aws', 'block');
      await api.gateway.terminalSet({ enabled: true });
      expect(f.terminal.set).toHaveBeenCalledWith({ enabled: true });
    } finally {
      close();
    }
  });

  it('用量 / 质量：读账本走 read*，标量参数解包', async () => {
    const { api, f, close } = setup();
    try {
      expect(await api.usage.state()).toEqual(usageState);
      expect(await api.usage.csv({ source: 'nomi' })).toBe('a,b');
      expect(f.usage.readCsv).toHaveBeenCalledWith({ source: 'nomi' });
      await api.usage.quotaRefresh({});
      expect(f.usage.refreshQuota).toHaveBeenCalledWith(undefined);
      await api.usage.quotaRefresh({ tool: 'codex' });
      expect(f.usage.refreshQuota).toHaveBeenLastCalledWith('codex');
      await api.usage.quotaHookSet({ enabled: true });
      expect(f.usage.setQuotaHook).toHaveBeenCalledWith(true);
      expect(await api.usage.clear()).toEqual(usageState);
      expect(await api.quality.query({ from: 0, to: 1 })).toMatchObject({ minSamples: 5 });
      expect(f.quality.query).toHaveBeenCalledWith({ from: 0, to: 1 });
      expect(await api.quality.clear()).toBe(true);
      await api.quality.exportCsv({ kind: 'table', query: { from: 0, to: 1 } });
      expect(f.quality.exportCsv).toHaveBeenCalledWith({
        kind: 'table',
        query: { from: 0, to: 1 },
      });
    } finally {
      close();
    }
  });

  it('更新 / 诊断 / 应用图标', async () => {
    const { api, f, close } = setup();
    try {
      expect(await api.updates.check()).toMatchObject({ status: 'checking' });
      expect(await api.updates.setAutoCheck({ on: false })).toEqual(update);
      expect(f.updates.setAutoCheck).toHaveBeenCalledWith(false);
      expect(await api.diagnostics.openFolder()).toBe(true);
      expect(await api.diagnostics.get()).toMatchObject({ dir: '/logs' });
      expect(await api.appIcon.get()).toMatchObject({ variant: 'sunset', platform: 'darwin' });
      expect(await api.appIcon.set({ variant: 'ink' })).toBe('ink');
      expect(appIcon.setIconVariant).toHaveBeenCalledWith('ink');
    } finally {
      close();
    }
  });

  it('供应商：委派给 AI runtime 的 ProviderService，错误里形似 Key 的片段打码', async () => {
    const { api, f, close } = setup();
    try {
      expect(await api.providers.presets()).toEqual([{ id: 'deepseek', name: 'DeepSeek' }]);
      expect(await api.providers.state()).toMatchObject({ roles: ['chat'] });
      const err = await api.providers.setActive({ id: 'x' }).catch((e: Error) => e);
      expect(f.providers.setActive).toHaveBeenCalledWith('x', undefined);
      expect((err as Error).message).toBe('bad key ***');
    } finally {
      close();
    }
  });

  it('服务没有创建：UNAVAILABLE', async () => {
    const { api, close } = setup({ withServices: false });
    try {
      await expect(api.theme.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(api.gateway.state()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(api.providers.state()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      close();
    }
  });

  it('看板娘窗口不能调只在对话窗口的过程；更新两个窗口都能调', async () => {
    const { api, f, close } = setup({ surface: 'mascot' });
    try {
      await expect(api.diagnostics.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.appIcon.set({ variant: 'ink' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(f.diagnostics.view).not.toHaveBeenCalled();
      expect(appIcon.setIconVariant).not.toHaveBeenCalled();
      expect(await api.updates.get()).toEqual(update);
    } finally {
      close();
    }
  });

  it('dangerous：不可信调用者不能确认私有地址', async () => {
    const { api, f, close } = setup({ trusted: false });
    try {
      await expect(
        api.gateway.confirmPrivateHost({ hostPort: '127.0.0.1:11434' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.gateway.confirmPrivateHost).not.toHaveBeenCalled();
    } finally {
      close();
    }
    const ok = setup();
    try {
      await ok.api.gateway.confirmPrivateHost({ hostPort: '127.0.0.1:11434' });
      expect(ok.f.gateway.confirmPrivateHost).toHaveBeenCalledWith('127.0.0.1:11434');
      expect(logger.info).toHaveBeenCalledWith(
        'contract dangerous call',
        expect.objectContaining({ name: 'gateway.confirmPrivateHost' }),
      );
    } finally {
      ok.close();
    }
  });

  it('供应商状态变化经应用事件总线发出旧通道（桥再转成 providers.changed）', () => {
    const { f, events, close } = setup();
    try {
      f.fireProvidersChanged();
      expect(events.last(PROVIDERS_CHANGED)).toEqual(providerState);
    } finally {
      close();
    }
  });
});

describe('host/contract · shell 事件桥', () => {
  it('旧通道 → 契约事件（含 null 事件与 open-panel 的 payload 归一）', () => {
    expect(shellEventBridge).toMatchObject({
      'ai:theme:changed': 'theme.changed',
      'ai:locale:changed': 'locale.changed',
      'ai:startup:changed': 'startup.changed',
      'ai:onboarding:show': 'onboarding.show',
      'ai:onboarding:profile-changed': 'onboarding.profileChanged',
      'ai:providers:changed': 'providers.changed',
      'ai:gateway:changed': 'gateway.changed',
      'ai:usage:changed': 'usage.changed',
      'ai:quality:changed': 'quality.changed',
      'updates:changed': 'updates.changed',
    });
    const inner = createRecordingAppEvents();
    const bridge = createContractEventBridge(inner, APP_EVENT_BRIDGE);
    const sink = { publish: jest.fn() };
    bridge.attach(sink);
    bridge.publish('ai:theme:changed', theme);
    bridge.publish('ai:gateway:changed', null);
    bridge.publish('updates:changed', update);
    bridge.publish('ai:providers:open-panel', undefined);
    expect(sink.publish.mock.calls).toEqual([
      ['theme.changed', theme],
      ['gateway.changed', null],
      ['updates.changed', update],
      ['providers.openPanel', {}],
    ]);
    // 旧通道照常广播
    expect(inner.published.map((e) => e.channel)).toEqual([
      'ai:theme:changed',
      'ai:gateway:changed',
      'updates:changed',
      'ai:providers:open-panel',
    ]);
    expect(bridge.contractEventOf('ai:onboarding:profile-changed')).toBe(
      'onboarding.profileChanged',
    );
  });
});
