// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EndpointInfoCard } from '../src/components/EndpointInfo';
import { configPathsOf } from '../src/hooks/useEndpointInfo';
import { resetToolQuotaMemo } from '../src/hooks/useToolQuota';

import type { CodingApiMockState } from './helpers/codingApi';

// D3 客户端走契约（services/api）；测试仍用旧通道形状的 window.aiIPC 假桥，经 helpers/codingApi 转发
const codingApi = vi.hoisted(() => ({}) as CodingApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/codingApi')).createCodingApiMock(codingApi),
);

// D2 的过程经契约替身转发到下面的旧桥假实现（见 helpers/shellApi）
vi.mock('../src/services/api', () => import('./helpers/shellApi'));

const NOW = Date.now();
const SUMMARY = (over = {}) => ({
  costUsd: 0.12,
  input: 8000,
  output: 4300,
  total: 12_300,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 3,
  estimatedCalls: 0,
  unpriced: [],
  ...over,
});
const ENDPOINT = (source: string, over = {}) => ({
  source,
  today: SUMMARY(),
  week: SUMMARY({ costUsd: 1.84, total: 90_000, calls: 20 }),
  series: Array.from({ length: 7 }, (_, i) => ({
    t: NOW - (6 - i) * 86_400_000,
    input: 1,
    output: 1,
    tokens: 1000 * (i + 1),
    costUsd: 0.1,
    calls: 1,
  })),
  byModel: [
    {
      key: 'gpt-5',
      tokens: 80_000,
      input: 1,
      output: 1,
      costUsd: 1.6,
      calls: 10,
      hasUnpriced: false,
    },
    {
      key: 'gpt-5-mini',
      tokens: 10_000,
      input: 1,
      output: 1,
      costUsd: 0.2,
      calls: 5,
      hasUnpriced: false,
    },
  ],
  byProvider: [
    {
      key: 'OpenAI',
      tokens: 90_000,
      input: 1,
      output: 1,
      costUsd: 1.8,
      calls: 15,
      hasUnpriced: false,
    },
  ],
  lastActivityAt: NOW - 2 * 3_600_000,
  ...over,
});
const QUOTA = (id: string) => ({
  id,
  label: id,
  status: 'ok',
  auth: 'subscription',
  plan: 'Plus',
  origin: 'app-server',
  updatedAt: NOW - 180_000,
  windows: [
    { id: 'primary', usedPercent: 32, windowMinutes: 300, resetAt: NOW + 2 * 3_600_000 },
    { id: 'secondary', usedPercent: 74, windowMinutes: 10080, resetAt: NOW + 3 * 86_400_000 },
  ],
});
const CLI = (kind: string, over = {}) => ({
  kind,
  path: `/usr/bin/${kind}`,
  version: '0.46.0',
  latest: '0.47.1',
  installMethod: 'npm',
  updateAvailable: true,
  updateSupported: true,
  ...over,
});

let calls: Array<[string, ...unknown[]]>;
let quota: unknown[];
let cli: unknown[];
let endpointFail = false;

beforeEach(() => {
  resetToolQuotaMemo();
  calls = [];
  quota = [QUOTA('codex'), { id: 'dsh', label: 'dsh', status: 'api', auth: 'api', windows: [] }];
  cli = [CLI('codex'), CLI('dsh', { version: '0.2.0-rc.1', updateAvailable: false })];
  endpointFail = false;
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: vi.fn(async (ch: string, ...a: unknown[]) => {
      calls.push([ch, ...a]);
      switch (ch) {
        case 'ai:usage:state':
          return { settings: { currency: 'USD', cnyPerUsd: 7.2, activeQuotaRefresh: true } };
        case 'ai:usage:quota':
          return quota;
        case 'ai:usage:quota-refresh':
          return { entries: quota, tools: a[0] ? { [a[0] as string]: { state: 'ok' } } : {} };
        case 'ai:usage:endpoint':
          if (endpointFail) return { __error: { message: 'endpoint boom' } };
          return ENDPOINT(String(a[0]));
        case 'ai:cli-update:inspect':
          return cli;
      }
      return null;
    }),
    on: vi.fn(() => () => undefined),
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

const renderCard = (
  backend: 'nomi' | 'claude' | 'codex' | 'dsh' | 'grok' = 'codex',
  bin?: string | null,
) => {
  const onOpenSettings = vi.fn();
  const r = render(
    <EndpointInfoCard
      backend={backend}
      bin={bin}
      running={1}
      lastTabActivity={NOW - 60_000}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { ...r, onOpenSettings };
};

describe('按端信息卡（左下角）', () => {
  it('精简：端图标 / 名称 / 套餐，只有最吃紧的一个额度窗口，今日花费；其余在抽屉里', async () => {
    const { findByTestId, getByTestId, queryByTestId } = renderCard();
    const card = await findByTestId('endpoint-info-card');
    await waitFor(() => expect(getByTestId('endpoint-card-auth').textContent).toBe('Plus'));
    expect(card.querySelector('[data-testid="endpoint-icon-codex"]')).toBeTruthy();
    expect(card.textContent).toContain('Codex');
    expect(card.textContent).not.toContain('v0.46.0');
    expect(card.textContent).not.toContain('已安装');
    expect(card.textContent).not.toContain('账号登录');
    expect(queryByTestId('endpoint-card-running')).toBeNull();
    expect(queryByTestId('cli-default-source')).toBeNull();
    // 只显示占用最高的那个窗口（每周 74%，不是 5 小时 32%）
    await waitFor(() => expect(card.querySelectorAll('[role="progressbar"]')).toHaveLength(1));
    expect(card.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('74');
    expect(card.textContent).toContain('每周');
    expect(card.textContent).not.toContain('5 小时');
    await waitFor(() => expect(getByTestId('endpoint-card-usage').textContent).toContain('$0.120'));
    expect(getByTestId('endpoint-card-usage').textContent).not.toContain('12.3K');
    // 卡片不展示默认模型或历史用量模型，避免混淆两种含义
    expect(card.textContent).not.toContain('gpt-5 · OpenAI');
  });

  it('单端刷新：只带本端参数调用额度刷新 + 重读用量，不触发其他端', async () => {
    const { findByTestId, getByTestId } = renderCard();
    await findByTestId('endpoint-info-card');
    fireEvent.click(getByTestId('endpoint-card-refresh'));
    await waitFor(() =>
      expect(calls.filter((c) => c[0] === 'ai:usage:quota-refresh')).toEqual([
        ['ai:usage:quota-refresh', 'codex'],
      ]),
    );
    expect(calls.filter((c) => c[0] === 'ai:usage:endpoint').length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c[0] === 'ai:usage:quota-refresh' && c[1] !== 'codex')).toBe(false);
    // 不打开抽屉
    expect(document.querySelector('[data-testid="endpoint-drawer"]')).toBeNull();
  });

  it('dsh（固定 API）：标「API 密钥」，没有进度条；刷新只重读用量', async () => {
    const { findByTestId, getByTestId } = renderCard('dsh');
    const card = await findByTestId('endpoint-info-card');
    await waitFor(() =>
      expect(getByTestId('endpoint-card-auth').textContent).toContain('API 密钥'),
    );
    expect(card.querySelector('[role="progressbar"]')).toBeNull();
    fireEvent.click(getByTestId('endpoint-card-refresh'));
    await waitFor(() =>
      expect(calls.filter((c) => c[0] === 'ai:usage:endpoint').length).toBeGreaterThanOrEqual(2),
    );
    expect(calls.some((c) => c[0] === 'ai:usage:quota-refresh')).toBe(false);
  });

  it('未安装：显示「未安装」与安装指引，不显示额度 / 用量 / 刷新', async () => {
    cli = [CLI('codex', { path: null, version: null, updateAvailable: false })];
    const { findByTestId, queryByTestId } = renderCard('codex');
    const card = await findByTestId('endpoint-info-card');
    await waitFor(() => expect(card.textContent).toContain('未安装'));
    expect(card.textContent).toContain('设置 → 编程助手');
    expect(queryByTestId('endpoint-card-refresh')).toBeNull();
    expect(card.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('安装状态以编程助手接入检测为准（mock / 自定义路径时 CLI 版本信息里没有路径也算已安装）', async () => {
    cli = [CLI('codex', { path: null, version: null, updateAvailable: false })];
    const { findByTestId, getByTestId } = renderCard('codex', '/mock/mock-codex.mjs');
    const card = await findByTestId('endpoint-info-card');
    await waitFor(() => expect(getByTestId('endpoint-card-usage')).toBeTruthy());
    expect(card.textContent).not.toContain('未安装');
    cleanup();
    const second = renderCard('codex', null);
    await waitFor(() =>
      expect(second.getByTestId('endpoint-card-install').textContent).toBe('未安装'),
    );
  });

  it('用量读取失败：卡片上显示错误提示', async () => {
    endpointFail = true;
    const { findByTestId } = renderCard();
    expect((await findByTestId('endpoint-card-error')).textContent).toContain('endpoint boom');
  });

  it('Nomi：标「API 密钥」、无额度条', async () => {
    const { findByTestId, getByTestId } = renderCard('nomi');
    const card = await findByTestId('endpoint-info-card');
    await waitFor(() =>
      expect(getByTestId('endpoint-card-auth').textContent).toContain('API 密钥'),
    );
    expect(card.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe('按端详情抽屉', () => {
  const openDrawer = async (backend: 'codex' | 'dsh' | 'nomi' = 'codex') => {
    const r = renderCard(backend);
    await r.findByTestId('endpoint-info-card');
    await waitFor(() => expect(r.getByTestId('endpoint-card-usage')).toBeTruthy());
    fireEvent.click(r.getByTestId('endpoint-card-open'));
    const dlg = await r.findByTestId('endpoint-drawer');
    return { ...r, dlg };
  };

  it('右侧抽屉（标题栏下方）+ 文字「关闭」；Esc / 点击关闭都能关闭', async () => {
    const { dlg, getByTestId } = await openDrawer();
    expect(dlg.getAttribute('role')).toBe('dialog');
    expect(dlg.className).toContain('cd-modal--drawer');
    expect(getByTestId('endpoint-drawer-overlay').className).toContain('cd-modal-overlay--drawer');
    const close = dlg.querySelector('.cd-modal__close') as HTMLButtonElement;
    expect(close.textContent).toBe('关闭');
    fireEvent.click(close);
    await waitFor(() =>
      expect(document.querySelector('[data-testid="endpoint-drawer"]')).toBeNull(),
    );
  });

  it('完整内容：概况 / 全部额度窗口 / 近 7 天趋势 / 按模型 / 配置路径（仅路径）/ 更新提示', async () => {
    const { dlg, getByTestId } = await openDrawer();
    await waitFor(() => expect(dlg.textContent).toContain('可更新到 0.47.1'));
    expect(getByTestId('endpoint-drawer-overview').textContent).toContain('运行中标签 1');
    expect(getByTestId('endpoint-drawer-overview').textContent).toContain('v0.46.0');
    const quotaSec = getByTestId('endpoint-drawer-quota');
    await waitFor(() =>
      expect(quotaSec.querySelectorAll('[data-testid="usage-quota-window"]')).toHaveLength(2),
    );
    expect(quotaSec.textContent).toContain('5 小时窗口');
    expect(quotaSec.textContent).toContain('每周窗口');
    expect(quotaSec.textContent).toContain('已用 74%');
    expect(getByTestId('endpoint-drawer-status').textContent).toContain('codex app-server');
    await waitFor(() => expect(getByTestId('endpoint-trend').children).toHaveLength(7));
    expect(getByTestId('endpoint-drawer-usage')).toBeTruthy();
    expect(getByTestId('endpoint-drawer').textContent).not.toContain('按模型 · 供应商');
    expect(getByTestId('endpoint-drawer-usage').textContent).toContain('$1.84');
    const cfg = getByTestId('endpoint-drawer-config');
    expect(cfg.textContent).toContain('~/.codex/config.toml');
    expect(cfg.textContent).toContain('不读取');
    // 不会为了展示配置而读文件：没有任何 fs / 凭据相关 IPC
    expect(calls.some((c) => /auth|credential|keychain/i.test(c[0]))).toBe(false);
  });

  it('抽屉内单端刷新 / 检查更新 / 跳转设置与用量页', async () => {
    const { getByTestId, onOpenSettings } = await openDrawer();
    fireEvent.click(getByTestId('endpoint-drawer-refresh'));
    await waitFor(() =>
      expect(calls.filter((c) => c[0] === 'ai:usage:quota-refresh')).toEqual([
        ['ai:usage:quota-refresh', 'codex'],
      ]),
    );
    fireEvent.click(getByTestId('endpoint-check-update'));
    await waitFor(() =>
      expect(calls.filter((c) => c[0] === 'ai:cli-update:inspect').map((c) => c[1])).toContain(
        true,
      ),
    );
    fireEvent.click(getByTestId('endpoint-open-usage'));
    expect(onOpenSettings).toHaveBeenCalledWith('usage');
    await waitFor(() =>
      expect(document.querySelector('[data-testid="endpoint-drawer"]')).toBeNull(),
    );
  });

  it('跳转到编程助手设置', async () => {
    const { getByTestId, onOpenSettings } = await openDrawer();
    fireEvent.click(getByTestId('endpoint-open-coding'));
    expect(onOpenSettings).toHaveBeenCalledWith('coding');
  });

  it('API 端（dsh）：抽屉里写「API 计费，无订阅额度」，没有额度刷新按钮', async () => {
    const { getByTestId, queryByTestId } = await openDrawer('dsh');
    expect(getByTestId('endpoint-drawer-quota').textContent).toContain('API 计费，无订阅额度');
    expect(queryByTestId('endpoint-drawer-refresh')).toBeNull();
  });
});

describe('配置路径（只有路径，不读内容）', () => {
  it('按端取 CLI 默认的配置文件路径；Nomi 没有', () => {
    expect(configPathsOf('claude')).toEqual([
      { label: 'settings.json', path: '~/.claude/settings.json' },
    ]);
    expect(configPathsOf('codex')[0]!.path).toBe('~/.codex/config.toml');
    expect(configPathsOf('grok')[0]!.path).toBe('~/.grok/config.toml');
    expect(configPathsOf('nomi')).toEqual([]);
  });
});
