// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvidersPage } from '../src/components/ProvidersPage';
import { routingStatus } from '../src/components/ProvidersPage/CliEndpointSection';
import type {
  CliProviderProfile,
  CliProviderState,
  CliRouteSettings,
} from '../src/services/cliProviderClient';

vi.mock('../src/components/lazyPanels', () => ({
  ProviderPanel: () => <div data-testid="nomi-provider-panel-stub">任务路由</div>,
}));

const PRESETS = [
  {
    id: 'custom',
    name: '自定义配置',
    category: 'custom',
    protocol: 'openai-chat',
    baseURL: '',
    defaultModel: '',
    models: [],
    requiresApiKey: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://api.deepseek.com',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    category: 'vendor',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
  },
];
const AGENTS = {
  settings: {
    enabled: true,
    stallMs: 1,
    cooldownMs: 1,
    osNotify: false,
    summaryEnabled: false,
    tools: {
      codex: true,
      claude: true,
      dsh: true,
      aider: false,
      cline: false,
      continue: false,
      cursor: false,
      gemini: false,
    },
  },
  sessions: [],
  detected: ['claude'],
  lastRemindAt: 0,
};

const prof = (o: Partial<CliProviderProfile>): CliProviderProfile => ({
  id: 'p',
  kind: 'claude',
  name: 'P',
  baseUrl: 'https://x.test/v1',
  model: 'm',
  apiFormat: 'anthropic_messages',
  needsRouting: false,
  hasKey: true,
  keyHint: '…1234',
  active: false,
  ...o,
});
const route: CliRouteSettings = {
  enabled: false,
  host: '127.0.0.1',
  port: 18721,
  claude: false,
  codex: false,
  listening: false,
  listenUrl: null,
};

function setup(profiles: CliProviderProfile[], routing: CliRouteSettings = route) {
  const calls: Array<[string, unknown[]]> = [];
  const st: CliProviderState = {
    profiles,
    claudeStore: '/ud/cli-providers/claude/store.json',
    codexStore: '/ud/cli-providers/codex/store.json',
    claudeSettings: '/home/u/.claude/settings.json',
    codexConfig: '/home/u/.codex/config.toml',
    dshStore: '/ud/cli-providers/dsh/store.json',
    dshConfig: '/home/u/.dsh/cordis.patch.yml',
    routing,
  };
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    if (ch === 'ai:cli-provider:state') return st;
    if (ch === 'ai:cli-provider:activate')
      return { ok: true, backups: [], restartRequired: false, usedRouting: false };
    if (ch === 'ai:cli-provider:deactivate') return { ok: true, backups: [] };
    if (ch === 'ai:cli-provider:test') return { ok: true, latencyMs: 123 };
    if (ch === 'ai:cli-route:set') return { ...routing, enabled: true };
    if (ch === 'ai:providers:presets') return PRESETS;
    if (ch === 'ai:cli-provider:upsert')
      return prof({ id: 'new1', kind: (args[0] as { kind: 'claude' }).kind, name: 'N' });
    if (ch === 'ai:agents:state' || ch === 'ai:agents:scan') return AGENTS;
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return calls;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

describe('routingStatus（路由开关与原因）', () => {
  it('原生格式直连；非原生且未开启时提示需开启；开启后显示本机地址', () => {
    expect(routingStatus('claude', null, route).mode).toBe('none');
    expect(routingStatus('claude', prof({}), route).mode).toBe('direct');
    const need = prof({ apiFormat: 'openai_chat_completions', needsRouting: true });
    expect(routingStatus('claude', need, route).mode).toBe('blocked');
    const on = { ...route, enabled: true, claude: true, listenUrl: 'http://127.0.0.1:18721' };
    const r = routingStatus('claude', need, on);
    expect(r.mode).toBe('routed');
    expect(r.text).toContain('127.0.0.1:18721');
    expect(routingStatus('dsh', null, route).mode).toBe('n/a');
  });
});

describe('ProvidersPage', () => {
  it('Nomi 区含任务路由面板；切到 Codex 后不再出现，且各端点独立', async () => {
    setup([]);
    const r = render(<ProvidersPage />);
    expect(r.getByTestId('providers-section-nomi')).toBeTruthy();
    expect(r.getByTestId('nomi-provider-panel-stub')).toBeTruthy();
    fireEvent.click(r.getByTestId('providers-endpoint-codex'));
    await waitFor(() => expect(r.getByTestId('providers-section-codex')).toBeTruthy());
    expect(r.queryByTestId('nomi-provider-panel-stub')).toBeNull();
    expect(r.getByTestId('cli-ep-intro').textContent).toContain(
      '~/.codex/config.toml'.replace('~', '/home/u'),
    );
    // 五个端点 + 「监视与会话」
    expect(r.getByTestId('providers-endpoint-tabs').querySelectorAll('[role=tab]').length).toBe(6);
  });

  it('只显示该端点自己的档案，未启用时显示 CLI 自带登录', async () => {
    setup([
      prof({ id: 'c1', kind: 'claude', name: 'Claude 档案' }),
      prof({ id: 'x1', kind: 'codex', name: 'Codex 档案', apiFormat: 'openai_responses' }),
    ]);
    localStorage.setItem('ai-chat:providerEndpoint', 'claude');
    const r = render(<ProvidersPage />);
    await waitFor(() => expect(r.getByTestId('cli-provider-row-c1')).toBeTruthy());
    expect(r.queryByTestId('cli-provider-row-x1')).toBeNull();
    expect(r.getByTestId('cli-ep-active').textContent).toContain('使用 CLI 自带登录/默认配置');
    expect(r.getByTestId('cli-ep-source').textContent).toContain('CLI 自带登录');
    expect(r.queryByTestId('cli-ep-use-default')).toBeNull();
  });

  it('启用 / 测速 / 改用自带登录走各自的 IPC，状态区显示来源与路由原因', async () => {
    const calls = setup([
      prof({
        id: 'c1',
        name: '中转',
        active: true,
        apiFormat: 'openai_chat_completions',
        needsRouting: true,
      }),
      prof({ id: 'c2', name: '另一个' }),
    ]);
    localStorage.setItem('ai-chat:providerEndpoint', 'claude');
    const r = render(<ProvidersPage />);
    await waitFor(() => expect(r.getByTestId('cli-ep-active').textContent).toBe('中转'));
    expect(r.getByTestId('cli-ep-source').textContent).toContain('Nomi 档案库');
    expect(r.getByTestId('cli-ep-routing').getAttribute('data-mode')).toBe('blocked');

    const row2 = r.getByTestId('cli-provider-row-c2');
    fireEvent.click(row2.querySelector('[data-testid=cli-provider-test]')!);
    await waitFor(() => expect(row2.textContent).toContain('123 ms'));
    expect(calls.some(([c, a]) => c === 'ai:cli-provider:test' && a[0] === 'c2')).toBe(true);

    fireEvent.click(row2.querySelector('[data-testid=cli-provider-enable]')!);
    await waitFor(() =>
      expect(calls.some(([c, a]) => c === 'ai:cli-provider:activate' && a[0] === 'c2')).toBe(true),
    );
    fireEvent.click(r.getByTestId('cli-ep-use-default'));
    await waitFor(() =>
      expect(calls.some(([c, a]) => c === 'ai:cli-provider:deactivate' && a[0] === 'claude')).toBe(
        true,
      ),
    );
  });

  it('默认使用 CLI 自带登录：显示「当前」卡片与空状态，添加走预设模板', async () => {
    setup([]);
    localStorage.setItem('ai-chat:providerEndpoint', 'codex');
    const r = render(<ProvidersPage />);
    await waitFor(() => expect(r.getByTestId('cli-provider-default')).toBeTruthy());
    expect(r.getByTestId('cli-default-current')).toBeTruthy();
    expect(r.getByTestId('cli-ep-active').textContent).toContain('使用 CLI 自带登录/默认配置');
    fireEvent.click(r.getByTestId('cli-add-provider'));
    await waitFor(() => expect(r.getByTestId('add-provider')).toBeTruthy());
    expect(r.getByTestId('preset-deepseek')).toBeTruthy();
    expect(r.getByTestId('preset-custom')).toBeTruthy();
  });

  it('选预设 → 预填地址；默认上游格式为端点原生（不受预设 protocol 改写）；保存并启用走 upsert + activate', async () => {
    const calls = setup([]);
    localStorage.setItem('ai-chat:providerEndpoint', 'claude');
    const r = render(<ProvidersPage />);
    await waitFor(() => r.getByTestId('cli-add-provider'));
    fireEvent.click(r.getByTestId('cli-add-provider'));
    await waitFor(() => r.getByTestId('preset-deepseek'));
    fireEvent.click(r.getByTestId('preset-deepseek'));
    await waitFor(() => r.getByTestId('cli-provider-form'));
    expect((r.getByTestId('cli-provider-baseurl') as HTMLInputElement).value).toBe(
      'https://api.deepseek.com',
    );
    // Claude Code 默认 Anthropic Messages 原生，即使 DeepSeek 预设是 openai-chat
    expect((r.getByTestId('cli-provider-format') as HTMLSelectElement).value).toBe(
      'anthropic_messages',
    );
    expect(r.queryByTestId('cli-editor-routing-hint')).toBeNull();
    fireEvent.change(r.getByTestId('cli-provider-key'), { target: { value: 'sk-test' } });
    fireEvent.click(r.getByTestId('cli-provider-save-activate'));
    await waitFor(() => {
      const c = calls.find(([ch]) => ch === 'ai:cli-provider:upsert');
      expect(c).toBeTruthy();
      expect(c![1][0]).toMatchObject({
        kind: 'claude',
        presetId: 'deepseek',
        apiFormat: 'anthropic_messages',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com',
      });
    });
    await waitFor(() =>
      expect(calls.some(([c, a]) => c === 'ai:cli-provider:activate' && a[0] === 'new1')).toBe(
        true,
      ),
    );
  });

  it('Codex 选 OpenAI 兼容预设仍默认 Responses 原生；改 Chat Completions 才提示需路由', async () => {
    setup([]);
    localStorage.setItem('ai-chat:providerEndpoint', 'codex');
    const r = render(<ProvidersPage />);
    await waitFor(() => r.getByTestId('cli-add-provider'));
    fireEvent.click(r.getByTestId('cli-add-provider'));
    await waitFor(() => r.getByTestId('preset-deepseek'));
    fireEvent.click(r.getByTestId('preset-deepseek'));
    await waitFor(() => r.getByTestId('cli-provider-form'));
    expect((r.getByTestId('cli-provider-format') as HTMLSelectElement).value).toBe(
      'openai_responses',
    );
    expect(r.queryByTestId('cli-editor-routing-hint')).toBeNull();
    fireEvent.change(r.getByTestId('cli-provider-format'), {
      target: { value: 'openai_chat_completions' },
    });
    await waitFor(() => expect(r.getByTestId('cli-editor-routing-hint')).toBeTruthy());
  });

  it('新增档案带当前端点 kind；dsh 的高级里没有路由开关；Anthropic 预设对 Claude 是原生格式', async () => {
    const calls = setup([]);
    localStorage.setItem('ai-chat:providerEndpoint', 'dsh');
    const r = render(<ProvidersPage />);
    await waitFor(() => expect(r.getByTestId('providers-section-dsh')).toBeTruthy());
    expect(r.queryByTestId('cli-route-enabled')).toBeNull();
    fireEvent.click(r.getByTestId('cli-add-provider'));
    await waitFor(() => r.getByTestId('preset-custom'));
    fireEvent.click(r.getByTestId('preset-custom'));
    await waitFor(() => r.getByTestId('cli-provider-baseurl'));
    expect((r.getByTestId('cli-provider-format') as HTMLSelectElement).value).toBe(
      'openai_responses',
    );
    expect(r.queryByTestId('cli-editor-routing-hint')).toBeNull();
    fireEvent.change(r.getByTestId('cli-provider-baseurl'), {
      target: { value: 'https://d.test/v1' },
    });
    fireEvent.click(r.getByTestId('cli-provider-save'));
    await waitFor(() => {
      const c = calls.find(([ch]) => ch === 'ai:cli-provider:upsert');
      expect(c).toBeTruthy();
      expect(c![1][0]).toMatchObject({
        kind: 'dsh',
        apiFormat: 'openai_responses',
      });
    });
  });

  it('Anthropic 预设 + Claude Code：原生格式，不提示路由', async () => {
    setup([]);
    localStorage.setItem('ai-chat:providerEndpoint', 'claude');
    const r = render(<ProvidersPage />);
    await waitFor(() => r.getByTestId('cli-add-provider'));
    fireEvent.click(r.getByTestId('cli-add-provider'));
    await waitFor(() => r.getByTestId('preset-anthropic'));
    fireEvent.click(r.getByTestId('preset-anthropic'));
    await waitFor(() => r.getByTestId('cli-provider-form'));
    expect(r.queryByTestId('cli-editor-routing-hint')).toBeNull();
  });

  it('每个 CLI 端点都有版本卡片；删除前先确认', async () => {
    const calls = setup([
      prof({ id: 'c1', kind: 'codex', name: '要删的', apiFormat: 'openai_responses' }),
    ]);
    localStorage.setItem('ai-chat:providerEndpoint', 'codex');
    const r = render(<ProvidersPage />);
    await waitFor(() => r.getByTestId('cli-provider-row-c1'));
    expect(r.getByTestId('cli-version-card-codex')).toBeTruthy();
    const confirm = vi.fn(() => false);
    window.confirm = confirm;
    fireEvent.click(r.getByTestId('cli-provider-delete'));
    expect(confirm).toHaveBeenCalled();
    expect(calls.some(([c]) => c === 'ai:cli-provider:remove')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(r.getByTestId('cli-provider-delete'));
    await waitFor(() => expect(calls.some(([c]) => c === 'ai:cli-provider:remove')).toBe(true));
  });

  it('添加/编辑在右侧抽屉打开，主列表与高级区仍可见', async () => {
    setup([prof({ id: 'c1', kind: 'codex', name: '已有档案', apiFormat: 'openai_responses' })]);
    localStorage.setItem('ai-chat:providerEndpoint', 'codex');
    const r = render(<ProvidersPage />);
    await waitFor(() => r.getByTestId('cli-provider-row-c1'));
    expect(r.queryByTestId('cli-provider-drawer')).toBeNull();

    fireEvent.click(r.getByTestId('cli-add-provider'));
    await waitFor(() => expect(r.getByTestId('cli-provider-drawer')).toBeTruthy());
    expect(r.getByTestId('add-provider')).toBeTruthy();
    expect(r.getByTestId('cli-provider-row-c1')).toBeTruthy();
    expect(r.getByTestId('cli-version-card-codex')).toBeTruthy();
    expect(r.getByTestId('cli-route-advanced')).toBeTruthy();

    fireEvent.click(r.getByTestId('preset-deepseek'));
    await waitFor(() => r.getByTestId('cli-provider-form'));
    expect(r.getByTestId('cli-provider-drawer')).toBeTruthy();
    expect(r.getByTestId('cli-provider-row-c1')).toBeTruthy();

    fireEvent.click(
      r.getByTestId('cli-provider-row-c1').querySelector('[data-testid=cli-provider-edit]')!,
    );
    await waitFor(() => {
      expect(r.getByTestId('cli-provider-form')).toBeTruthy();
      expect(r.getByTestId('cli-provider-drawer')).toBeTruthy();
    });
    expect(r.getByTestId('cli-version-card-codex')).toBeTruthy();
  });

  it('「监视与会话」标签：监视开关、系统通知、检测到的工具、立即扫描；与提醒设置分开', async () => {
    const calls = setup([]);
    localStorage.setItem('ai-chat:providerEndpoint', 'monitor');
    const onNotify = vi.fn();
    const r = render(<ProvidersPage onOpenNotify={onNotify} />);
    await waitFor(() => r.getByTestId('coding-monitor'));
    await waitFor(() => r.getByTestId('agents-enabled'));
    expect(r.getByTestId('agents-os-notify')).toBeTruthy();
    // 总结播报：默认关，打开后持久化到监视设置
    fireEvent.click(r.getByTestId('agents-summary'));
    await waitFor(() =>
      expect(
        calls.some(
          ([c, p]) =>
            c === 'ai:agents:set-settings' &&
            (p as Array<{ summaryEnabled?: boolean }>)[0]?.summaryEnabled === true,
        ),
      ).toBe(true),
    );
    expect(r.getByTestId('agents-tool-claude')).toBeTruthy();
    fireEvent.click(r.getByTestId('agents-scan'));
    await waitFor(() => expect(calls.some(([c]) => c === 'ai:agents:scan')).toBe(true));
    fireEvent.click(r.getByTestId('agents-open-notify'));
    expect(onNotify).toHaveBeenCalled();
    // 不再混着日程 / 提醒的东西
    expect(r.queryByTestId('sched-panel')).toBeNull();
  });
});
