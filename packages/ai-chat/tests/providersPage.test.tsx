// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvidersPage } from '../src/components/ProvidersPage';
import { cliUpdateClient } from '../src/services/cliUpdateClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const AGENTS = {
  settings: {
    enabled: true,
    stallMs: 1,
    cooldownMs: 1,
    summaryEnabled: false,
    tools: {
      codex: true,
      claude: true,
      dsh: true,
      grok: false,
      gemini: false,
    },
  },
  sessions: [],
  detected: ['claude'],
  lastRemindAt: 0,
};

function setup() {
  const calls: Array<[string, unknown]> = [];
  const invoke = vi.fn(async (ch: string, input?: unknown) => {
    calls.push([ch, input]);
    if (ch === 'agents.state' || ch === 'agents.scan') return AGENTS;
    if (ch === 'cliAccount.list') return [];
    if (ch === 'cliUpdate.inspect')
      return [
        { kind: 'claude', path: '/usr/bin/claude', version: '2.1.0' },
        { kind: 'codex', path: null, version: null },
      ];
    if (ch === 'cliUpdate.environment')
      return {
        nodeVersion: '22.12.0',
        nodePath: '/usr/bin/node',
        npmPath: '/usr/bin/npm',
        requirements: [{ kind: 'claude', minNode: 18, ok: true }],
      };
    return {};
  });
  installFakeApi(invoke);
  return calls;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  cliUpdateClient.resetCache();
  resetFakeApi();
});

describe('ProvidersPage', () => {
  it('助手卡片显示主进程报告的安装状态；没报告的端点不显示状态', async () => {
    setup();
    const r = render(<ProvidersPage />);
    await waitFor(() =>
      expect(r.getByTestId('providers-endpoint-status-claude').textContent).toBe('已安装 2.1.0'),
    );
    expect(r.getByTestId('providers-endpoint-status-codex').textContent).toBe('未安装');
    expect(r.queryByTestId('providers-endpoint-status-grok')).toBeNull();
  });

  it('选择条和版本分组共用一次检测；切换助手直接显示上次结果，不再闪「检测中」', async () => {
    const calls = setup();
    localStorage.setItem('ai-chat:providerEndpoint', 'claude');
    const r = render(<ProvidersPage onOpenModels={() => undefined} />);
    await waitFor(() =>
      expect(r.getByTestId('cli-version-installed-claude').textContent).toBe('2.1.0'),
    );
    expect(calls.filter(([c]) => c === 'cliUpdate.inspect')).toHaveLength(1);
    fireEvent.click(r.getByTestId('providers-endpoint-codex'));
    // 同一帧里就是上次的结果（未安装），不是「检测中…」
    expect(r.getByTestId('cli-version-state-codex').getAttribute('data-state')).toBe('missing');
    expect(r.getByTestId('cli-version-state-codex').textContent).not.toContain('检测中');
  });

  it('分段标签「助手 / 监视与会话」；左栏是所有内置 CLI + 外部 CLI + 通用，旧的 Nomi 选中值落到第一个', async () => {
    setup();
    localStorage.setItem('ai-chat:providerEndpoint', 'nomi');
    const r = render(<ProvidersPage onOpenModels={() => undefined} />);
    expect(r.queryByTestId('providers-endpoint-nomi')).toBeNull();
    const tabs = [...r.getByTestId('providers-endpoint-tabs').querySelectorAll('[role=tab]')];
    expect(tabs.map((b) => b.getAttribute('data-testid'))).toEqual([
      'providers-endpoint-claude',
      'providers-endpoint-codex',
      'providers-endpoint-dsh',
      'providers-endpoint-grok',
      'providers-endpoint-gemini',
      'providers-endpoint-kimi',
      'providers-endpoint-minimax',
      'providers-endpoint-external',
      'providers-endpoint-general',
    ]);
    await waitFor(() => expect(r.getByTestId('providers-section-claude')).toBeTruthy());
    fireEvent.click(r.getByTestId('providers-endpoint-codex'));
    await waitFor(() => expect(r.getByTestId('providers-section-codex')).toBeTruthy());
    // 去「监视与会话」再回来，仍是刚才看的 Codex
    fireEvent.click(r.getByTestId('providers-endpoint-monitor'));
    await waitFor(() => r.getByTestId('coding-monitor'));
    expect(r.queryByTestId('providers-endpoint-tabs')).toBeNull();
    fireEvent.click(r.getByTestId('providers-view-assistants'));
    await waitFor(() => expect(r.getByTestId('providers-section-codex')).toBeTruthy());
  });

  it.each(['claude', 'codex', 'grok', 'gemini', 'kimi', 'minimax'] as const)(
    '%s：版本卡片 + 官方账号 + 去「模型」页的入口；没有第三方供应商列表和路由',
    async (kind) => {
      const calls = setup();
      localStorage.setItem('ai-chat:providerEndpoint', kind);
      const onOpenModels = vi.fn();
      const r = render(<ProvidersPage onOpenModels={onOpenModels} />);
      await waitFor(() => expect(r.getByTestId(`providers-section-${kind}`)).toBeTruthy());
      expect(r.getByTestId(`cli-version-card-${kind}`)).toBeTruthy();
      expect(r.getByTestId(`cli-accounts-${kind}`)).toBeTruthy();
      expect(r.queryByTestId('cli-add-provider')).toBeNull();
      expect(r.queryByTestId('cli-route-advanced')).toBeNull();
      fireEvent.click(r.getByTestId('cli-open-models'));
      expect(onOpenModels).toHaveBeenCalledTimes(1);
      expect(calls.some(([c]) => c.startsWith('ai:cli-provider:'))).toBe(false);
      expect(calls.some(([c]) => c.startsWith('ai:cli-route:'))).toBe(false);
    },
  );

  it('运行环境与权限只在「通用」里；助手详情里不出现', async () => {
    setup();
    localStorage.setItem('ai-chat:providerEndpoint', 'claude');
    const r = render(<ProvidersPage onOpenModels={() => undefined} />);
    await waitFor(() => r.getByTestId('providers-section-claude'));
    expect(r.queryByTestId('cli-runtime-environment')).toBeNull();
    expect(r.queryByTestId('providers-runtime-warning')).toBeNull();
    expect(r.getByTestId('providers-endpoint-status-general').textContent).toBe('运行环境与权限');
    fireEvent.click(r.getByTestId('providers-endpoint-general'));
    await waitFor(() => r.getByTestId('cli-runtime-environment'));
    expect(r.queryByTestId('providers-section-claude')).toBeNull();
    // 上下键在左栏里切换
    fireEvent.keyDown(r.getByTestId('providers-endpoint-tabs'), { key: 'ArrowUp' });
    await waitFor(() => r.getByTestId('external-clis'));
  });

  it('运行环境有问题：「通用」亮警示，助手详情顶部提示，点一下去「通用」', async () => {
    setup();
    const calls: string[] = [];
    installFakeApi(async (ch: string) => {
      calls.push(ch);
      if (ch === 'cliAccount.list') return [];
      if (ch === 'cliUpdate.inspect') return [];
      if (ch === 'cliUpdate.environment')
        return { nodeVersion: null, nodePath: null, npmPath: null, requirements: [] };
      return {};
    });
    localStorage.setItem('ai-chat:providerEndpoint', 'codex');
    const r = render(<ProvidersPage onOpenModels={() => undefined} />);
    await waitFor(() => r.getByTestId('providers-runtime-warning'));
    const st = r.getByTestId('providers-endpoint-status-general');
    expect(st.getAttribute('data-tone')).toBe('warn');
    expect(st.textContent).toBe('运行环境需要处理');
    fireEvent.click(r.getByText('去「通用」查看'));
    await waitFor(() => r.getByTestId('cli-runtime-notice'));
  });

  it('dsh：没有官方账号，只有版本卡片和去「模型」页的入口', async () => {
    setup();
    localStorage.setItem('ai-chat:providerEndpoint', 'dsh');
    const r = render(<ProvidersPage onOpenModels={() => undefined} />);
    await waitFor(() => expect(r.getByTestId('providers-section-dsh')).toBeTruthy());
    expect(r.queryByTestId('cli-accounts-dsh')).toBeNull();
    expect(r.getByTestId('cli-open-models')).toBeTruthy();
  });

  it('「监视与会话」：活跃会话超过 20 条时分页', async () => {
    const sessions = Array.from({ length: 25 }, (_, i) => ({
      id: `s${i}`,
      kind: 'codex',
      title: `会话 ${i}`,
      status: 'running',
      mtime: Date.now() - i * 1000,
      path: `/tmp/s${i}.jsonl`,
      source: 'file',
    }));
    installFakeApi(async (ch: string) => {
      if (ch === 'agents.state' || ch === 'agents.scan') return { ...AGENTS, sessions };
      return {};
    });
    localStorage.setItem('ai-chat:providerEndpoint', 'monitor');
    const r = render(<ProvidersPage />);
    await waitFor(() => r.getByTestId('agents-sessions-pager'));
    const rows = () =>
      r.getByTestId('agents-sessions').querySelectorAll('[data-testid="agents-session-file"]');
    expect(rows().length).toBe(20);
    expect(r.getByTestId('agents-sessions-page').textContent).toContain('25');
    fireEvent.click(r.getByTestId('agents-sessions-page-next'));
    await waitFor(() => expect(rows().length).toBe(5));
  });

  it('「监视与会话」标签：监视开关、检测到的工具、立即扫描；与提醒设置分开', async () => {
    const calls = setup();
    localStorage.setItem('ai-chat:providerEndpoint', 'monitor');
    const onNotify = vi.fn();
    const r = render(<ProvidersPage onOpenNotify={onNotify} />);
    await waitFor(() => r.getByTestId('coding-monitor'));
    await waitFor(() => r.getByTestId('agents-enabled'));
    expect(r.queryByTestId('agents-os-notify')).toBeNull();
    // 总结播报：默认关，打开后持久化到监视设置
    fireEvent.click(r.getByTestId('agents-summary'));
    await waitFor(() =>
      expect(
        calls.some(
          ([c, p]) =>
            c === 'agents.setSettings' &&
            (p as { summaryEnabled?: boolean } | undefined)?.summaryEnabled === true,
        ),
      ).toBe(true),
    );
    expect(r.getByTestId('agents-tool-claude')).toBeTruthy();
    fireEvent.click(r.getByTestId('agents-scan'));
    await waitFor(() => expect(calls.some(([c]) => c === 'agents.scan')).toBe(true));
    fireEvent.click(r.getByTestId('agents-open-notify'));
    expect(onNotify).toHaveBeenCalled();
    // 不再混着日程 / 提醒的东西
    expect(r.queryByTestId('sched-panel')).toBeNull();
  });
});
