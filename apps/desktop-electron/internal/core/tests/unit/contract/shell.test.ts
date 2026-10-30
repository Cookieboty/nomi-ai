/**
 * D2（contract/shell.ts）：theme / locale / startup / onboarding / providers / gateway / usage /
 * quality / updates / diagnostics 的处理函数委派给服务、`appIcon.*` 由宿主片段补上、服务缺失时 UNAVAILABLE、
 * 只在对话窗口的过程拒绝桌面角色、dangerous 过程拒绝不可信调用者、服务发布契约事件、
 * 供应商变化经应用事件总线发出。
 */

import { createClient } from '@nomi-ai/contract';
import { createInProcessServer } from '@nomi-ai/contract/testing';
import type { HostPorts } from '@nomi-ai/host-ports';

import { createAppRouter } from '../../../src/contract/router';
import type { CoreContractServices } from '../../../src/contract/services';
import type { AppHandlers, ContractDeps } from '../../../src/contract/types';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

/** 应用图标是宿主的事：这里用假的宿主片段 */
const appIcon = {
  appIconState: jest.fn(() => ({
    variant: 'sunset' as const,
    platform: 'darwin' as const,
    previews: { sunset: 'data:a', cream: 'data:b', ink: 'data:c' },
  })),
  setIconVariant: jest.fn((v: unknown) => (v === 'ink' ? ('ink' as const) : ('sunset' as const))),
};
const hostHandlers: Partial<AppHandlers> = {
  'appIcon.get': () => appIcon.appIconState(),
  'appIcon.set': ({ variant }) => appIcon.setIconVariant(variant),
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
  const services: CoreContractServices = {};
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
  const app = createAppRouter({ deps, hostHandlers });
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
      expect(await api.onboarding.mascot({ type: 'gesture', name: 'nod' })).toBe(true);
      expect(f.onboarding.mascot).toHaveBeenCalledWith({ type: 'gesture', name: 'nod' });
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

  it('桌面角色窗口不能调只在对话窗口的过程；更新两个窗口都能调', async () => {
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

  it('供应商状态变化经应用事件总线发布 providers.changed', () => {
    const { f, events, close } = setup();
    try {
      f.fireProvidersChanged();
      expect(events.last('providers.changed')).toEqual(providerState);
    } finally {
      close();
    }
  });
});
