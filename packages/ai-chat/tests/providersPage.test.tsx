// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvidersPage } from '../src/components/ProvidersPage';

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

function setup() {
  const calls: Array<[string, unknown[]]> = [];
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    if (ch === 'ai:agents:state' || ch === 'ai:agents:scan') return AGENTS;
    if (ch === 'ai:cli-account:list') return [];
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

describe('ProvidersPage', () => {
  it('Nomi 区只有指向「模型」页的入口；五个 CLI 端点 + 「监视与会话」', async () => {
    setup();
    const onOpenModels = vi.fn();
    const r = render(<ProvidersPage onOpenModels={onOpenModels} />);
    expect(r.getByTestId('providers-section-nomi')).toBeTruthy();
    fireEvent.click(r.getByTestId('providers-open-models'));
    expect(onOpenModels).toHaveBeenCalled();
    fireEvent.click(r.getByTestId('providers-endpoint-codex'));
    await waitFor(() => expect(r.getByTestId('providers-section-codex')).toBeTruthy());
    expect(r.queryByTestId('providers-open-models')).toBeNull();
    expect(r.getByTestId('providers-endpoint-tabs').querySelectorAll('[role=tab]').length).toBe(7);
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

  it('「监视与会话」标签：监视开关、系统通知、检测到的工具、立即扫描；与提醒设置分开', async () => {
    const calls = setup();
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
