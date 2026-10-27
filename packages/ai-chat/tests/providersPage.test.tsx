// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvidersPage } from '../src/components/ProvidersPage';
import { cliUpdateClient } from '../src/services/cliUpdateClient';

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
  const calls: Array<[string, unknown[]]> = [];
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    if (ch === 'ai:agents:state' || ch === 'ai:agents:scan') return AGENTS;
    if (ch === 'ai:cli-account:list') return [];
    if (ch === 'ai:cli-update:inspect')
      return [
        { kind: 'claude', path: '/usr/bin/claude', version: '2.1.0' },
        { kind: 'codex', path: null, version: null },
      ];
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return calls;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  cliUpdateClient.resetCache();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
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
    expect(calls.filter(([c]) => c === 'ai:cli-update:inspect')).toHaveLength(1);
    fireEvent.click(r.getByTestId('providers-endpoint-codex'));
    // 同一帧里就是上次的结果（未安装），不是「检测中…」
    expect(r.getByTestId('cli-version-state-codex').getAttribute('data-state')).toBe('missing');
    expect(r.getByTestId('cli-version-state-codex').textContent).not.toContain('检测中');
  });

  it('分段标签「助手 / 监视与会话」；助手选择条只有五个 CLI，旧的 Nomi 选中值落到第一个', async () => {
    setup();
    localStorage.setItem('ai-chat:providerEndpoint', 'nomi');
    const r = render(<ProvidersPage onOpenModels={() => undefined} />);
    expect(r.queryByTestId('providers-endpoint-nomi')).toBeNull();
    expect(r.getByTestId('providers-endpoint-tabs').querySelectorAll('[role=tab]').length).toBe(5);
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

  it.each(['claude', 'codex', 'grok', 'gemini'] as const)(
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

  it('dsh：没有官方账号，只有版本卡片和去「模型」页的入口', async () => {
    setup();
    localStorage.setItem('ai-chat:providerEndpoint', 'dsh');
    const r = render(<ProvidersPage onOpenModels={() => undefined} />);
    await waitFor(() => expect(r.getByTestId('providers-section-dsh')).toBeTruthy());
    expect(r.queryByTestId('cli-accounts-dsh')).toBeNull();
    expect(r.getByTestId('cli-open-models')).toBeTruthy();
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
