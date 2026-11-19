// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { cliTabReadiness } from '../src/hooks/useCliTabReadiness';
import type { CliAccount } from '../src/services/cliAccountClient';
import type { GatewayState } from '../src/services/gatewayClient';
import type { HarnessTabMeta } from '../src/services/harnessClient';

const makeTab = (over: Partial<HarnessTabMeta> = {}): HarnessTabMeta => ({
  id: 'tab-1',
  title: 'Claude Code',
  backend: 'claude',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  source: 'thirdParty',
  ...over,
});

const makeProvider = (id: string, name: string, models: string[]) => ({
  id,
  name,
  enabled: true,
  source: 'user' as const,
  urls: { chat: 'https://example.com' },
  keys: [],
  models: models.map((m) => ({ id: m, enabled: true, toolCalling: true })),
});

const makeGateway = (
  providers: ReturnType<typeof makeProvider>[],
  clients: GatewayState['clients'] = {},
): GatewayState => ({
  providers,
  clients,
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  allowedPrivateHosts: [],
  port: 1,
});

const signedInAccount = (id = 'acct-1'): CliAccount => ({
  id,
  kind: 'claude',
  label: 'Work',
  loggedIn: true,
  identity: { key: 'u@example.com', email: 'u@example.com' },
  active: true,
  inUse: 0,
  createdAt: 0,
});

describe('cliTabReadiness', () => {
  it('空标签或 nomi 后端始终 ready；gateway/account/launcher 未就绪时 loading（仅第三方助手不等官方）', () => {
    expect(
      cliTabReadiness({
        tab: null,
        gateway: null,
        accounts: [],
        accountsReady: false,
        hasLocalLogin: false,
      }).status,
    ).toBe('ready');

    expect(
      cliTabReadiness({
        tab: makeTab({ backend: 'nomi' }),
        gateway: null,
        accounts: [],
        accountsReady: false,
        hasLocalLogin: false,
      }).status,
    ).toBe('ready');

    expect(
      cliTabReadiness({
        tab: makeTab(),
        gateway: null,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }).status,
    ).toBe('loading');

    expect(
      cliTabReadiness({
        tab: makeTab(),
        gateway: makeGateway([]),
        accounts: [],
        accountsReady: false,
        hasLocalLogin: false,
      }).status,
    ).toBe('loading');

    expect(
      cliTabReadiness({
        tab: makeTab(),
        gateway: makeGateway([]),
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
        launcherReady: false,
      }).status,
    ).toBe('loading');

    // thirdPartyOnly（gemini）只看 gateway，不被 accountsReady / launcherReady 阻塞
    expect(
      cliTabReadiness({
        tab: makeTab({ backend: 'gemini' }),
        gateway: makeGateway([makeProvider('p1', 'P1', ['m1'])]),
        accounts: [],
        accountsReady: false,
        hasLocalLogin: false,
        launcherReady: false,
      }),
    ).toEqual({ status: 'ready', reason: null, thirdPartyOnly: true });
  });

  it('thirdParty 来源：多供应商无默认时 needs-model，单供应商或已选模型时 ready，已删模型转回 needs-model', () => {
    const twoProviders = makeGateway([
      makeProvider('p1', 'Provider 1', ['m1']),
      makeProvider('p2', 'Provider 2', ['m2']),
    ]);

    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'thirdParty', modelOverride: null }),
        gateway: twoProviders,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }),
    ).toMatchObject({ status: 'needs-model', thirdPartyOnly: false });

    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'thirdParty', modelOverride: 'p2/m2' }),
        gateway: twoProviders,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }),
    ).toEqual({ status: 'ready', reason: null, thirdPartyOnly: false });

    // modelOverride 指向已被移除的模型 -> needs-model
    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'thirdParty', modelOverride: 'gone/m0' }),
        gateway: twoProviders,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }).status,
    ).toBe('needs-model');

    // 单供应商自动选中首个可用编码模型 -> ready
    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'thirdParty', modelOverride: null }),
        gateway: makeGateway([makeProvider('p1', 'Provider 1', ['m1'])]),
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }),
    ).toEqual({ status: 'ready', reason: null, thirdPartyOnly: false });
  });

  it('无官方/本机登录且无任何可用三方模型时 needs-setup；若有另一条路可走则 needs-model', () => {
    const emptyGw = makeGateway([]);
    const withProviderGw = makeGateway([makeProvider('p1', 'Provider 1', ['m1'])]);

    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'official' }),
        gateway: emptyGw,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }),
    ).toMatchObject({ status: 'needs-setup', thirdPartyOnly: false });

    expect(
      cliTabReadiness({
        tab: makeTab({ backend: 'gemini', source: 'thirdParty' }),
        gateway: emptyGw,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }),
    ).toMatchObject({ status: 'needs-setup', thirdPartyOnly: true });

    // 官方未登录但已有三方模型 -> needs-model
    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'official' }),
        gateway: withProviderGw,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
      }).status,
    ).toBe('needs-model');

    // 本机未登录但有已登录官方账号 -> needs-model
    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'local' }),
        gateway: emptyGw,
        accounts: [signedInAccount()],
        accountsReady: true,
        hasLocalLogin: false,
      }).status,
    ).toBe('needs-model');

    // launcherAccountSource === 'local' 管理官方来源 -> ready
    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'official' }),
        gateway: emptyGw,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: false,
        launcherAccountSource: 'local',
      }).status,
    ).toBe('ready');

    // 本机已登录 -> ready
    expect(
      cliTabReadiness({
        tab: makeTab({ source: 'local' }),
        gateway: emptyGw,
        accounts: [],
        accountsReady: true,
        hasLocalLogin: true,
      }).status,
    ).toBe('ready');
  });
});
