// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UsagePanel } from '../src/components/UsagePanel';
import { priceSyncMessage } from '../src/components/UsagePanel/Pricing';

const summary = (over = {}) => ({
  costUsd: 12.5,
  input: 2_000_000,
  output: 300_000,
  total: 2_300_000,
  cacheRead: 500_000,
  cacheWrite: 10_000,
  calls: 42,
  estimatedCalls: 3,
  unpriced: [{ model: 'mystery-1', tokens: 1000, calls: 2 }],
  ...over,
});

const NOW = Date.now();
const series = Array.from({ length: 7 }, (_, i) => ({
  t: NOW - (6 - i) * 86_400_000,
  input: 100 * (i + 1),
  output: 50 * (i + 1),
  tokens: 150 * (i + 1),
  costUsd: 0.1 * (i + 1),
  calls: i + 1,
}));

const QUERY = {
  range: { id: '7d', from: NOW - 6 * 86_400_000, to: NOW, bucket: 'day' },
  summary: summary(),
  prev: summary({ costUsd: 5, total: 1_000_000, input: 900_000, output: 100_000 }),
  series,
  bySource: [
    {
      key: 'claude',
      tokens: 1_500_000,
      input: 1_300_000,
      output: 200_000,
      costUsd: 9,
      calls: 20,
      hasUnpriced: false,
    },
    {
      key: 'nomi',
      tokens: 800_000,
      input: 700_000,
      output: 100_000,
      costUsd: 3.5,
      calls: 22,
      hasUnpriced: true,
    },
  ],
  byProvider: [
    {
      key: 'Anthropic',
      tokens: 1_500_000,
      input: 1,
      output: 1,
      costUsd: 9,
      calls: 20,
      hasUnpriced: false,
    },
  ],
  byModel: [
    {
      key: 'claude-sonnet-4-5',
      tokens: 1_500_000,
      input: 1,
      output: 1,
      costUsd: 9,
      calls: 20,
      hasUnpriced: false,
    },
    {
      key: 'mystery-1',
      tokens: 800_000,
      input: 1,
      output: 1,
      costUsd: 0,
      calls: 22,
      hasUnpriced: true,
    },
  ],
};

const today = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const HEAT = Array.from({ length: 365 }, (_, i) => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (364 - i));
  return {
    date: dayKey(d),
    tokens: i % 5 === 0 ? i * 100 : 0,
    costUsd: i % 5 === 0 ? i * 0.01 : 0,
    calls: i % 5 === 0 ? 3 : 0,
  };
});

const STATE = {
  settings: {
    enabled: true,
    readToolLogs: true,
    activeQuotaRefresh: true,
    retention: '1y',
    currency: 'USD',
    cnyPerUsd: 7.2,
    customPrices: [],
    clearedAt: 0,
    dailyBudget: 0,
    monthlyBudget: 0,
    taskAlert: 0,
  },
  detected: ['claude', 'codex'],
  records: 42,
  lastScanAt: NOW,
  pricing: {
    date: '2026-10-16',
    builtin: [
      {
        model: 'claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5',
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    ],
  },
};

const ROWS = {
  rows: [
    {
      key: 'a',
      ts: NOW,
      source: 'claude',
      provider: 'Anthropic',
      model: 'claude-sonnet-4-5',
      session: 's1',
      project: 'proj',
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 2,
      tokens: 15,
      costUsd: 0.5,
      estimated: false,
    },
    {
      key: 'b',
      ts: NOW - 1000,
      source: 'nomi',
      provider: 'X',
      model: 'mystery-1',
      input: 1000,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 1050,
      costUsd: null,
      estimated: true,
    },
  ],
  total: 2,
  summary: summary(),
  facets: {
    sources: ['claude', 'nomi'],
    models: ['claude-sonnet-4-5', 'mystery-1'],
    sessions: [{ id: 's1', label: 'proj · s1' }],
  },
};

let calls: Array<[string, ...unknown[]]>;
let state: typeof STATE;
let emptyData = false;
let quota: unknown[] = [];
let refreshTools: Record<string, unknown> = {};
let refreshEntries: unknown[] | null = null;
let hook: Record<string, unknown> = {
  supported: true,
  enabled: false,
  hadOwnStatusLine: false,
  hasSnapshot: false,
};

function install() {
  calls = [];
  state = JSON.parse(JSON.stringify(STATE));
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: vi.fn(async (ch: string, ...a: unknown[]) => {
      calls.push([ch, ...a]);
      switch (ch) {
        case 'ai:usage:state':
          return emptyData ? { ...state, records: 0 } : state;
        case 'ai:usage:query':
          return emptyData
            ? {
                ...QUERY,
                summary: summary({ calls: 0, unpriced: [], estimatedCalls: 0 }),
                series: [],
              }
            : { ...QUERY, range: { ...QUERY.range, id: a[0] } };
        case 'ai:usage:heatmap':
          return { days: HEAT, today: dayKey(today) };
        case 'ai:usage:details':
          return ROWS;
        case 'ai:usage:csv':
          return 'a,b\n1,2\n';
        case 'ai:usage:set-settings':
          state = { ...state, settings: { ...state.settings, ...(a[0] as object) } };
          return state.settings;
        case 'ai:usage:quota':
          return quota;
        case 'ai:usage:quota-refresh':
          if (refreshEntries) quota = refreshEntries;
          return { entries: quota, tools: refreshTools };
        case 'ai:usage:quota-hook':
          return hook;
        case 'ai:usage:quota-hook-set':
          hook = { ...hook, enabled: a[0] === true };
          return hook;
        case 'ai:usage:clear':
          state = { ...state, records: 0 };
          return state;
        case 'ai:usage:scan':
          return { ...state, added: 0, files: 0 };
        case 'ai:usage:price-sync':
          state = {
            ...state,
            pricing: {
              ...state.pricing,
              sync: { count: 321, fetchedAt: NOW, checkedAt: NOW, tableDate: '2026-10-16' },
            },
          };
          return { ...state, result: { ok: true, status: 'updated', count: 321, skipped: 2 } };
      }
      return null;
    }),
    on: vi.fn(() => () => undefined),
  };
}

beforeEach(() => {
  emptyData = false;
  refreshTools = {};
  refreshEntries = null;
  hook = { supported: true, enabled: false, hadOwnStatusLine: false, hasSnapshot: false };
  quota = [
    { id: 'codex', label: 'Codex', status: 'unavailable', windows: [] },
    { id: 'claude', label: 'Claude Code', status: 'unavailable', windows: [] },
  ];
  install();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

const queries = () => calls.filter((c) => c[0] === 'ai:usage:query').map((c) => c[1]);

describe('UsagePanel 概览', () => {
  it('四张摘要卡片 + 未定价提示 + 估算提示 + 趋势 / 分布 / 排行 / 热力图', async () => {
    const { findByTestId, getByTestId } = render(<UsagePanel />);
    const cost = await findByTestId('usage-card-cost');
    expect(cost.textContent).toContain('$12.50');
    expect(cost.textContent).toContain('+150%');
    expect(getByTestId('usage-card-total').textContent).toContain('2.3M');
    expect(getByTestId('usage-card-input').textContent).toContain('2M');
    expect(getByTestId('usage-card-input').textContent).toContain('510K');
    expect(getByTestId('usage-card-output').textContent).toContain('300K');
    expect(getByTestId('usage-unpriced-notice').textContent).toContain('mystery-1');
    expect(getByTestId('usage-estimated-notice').textContent).toContain('3');
    expect(getByTestId('usage-trend')).toBeTruthy();
    expect(getByTestId('usage-breakdown-source').textContent).toContain('Claude Code');
    expect(getByTestId('usage-breakdown-model').textContent).toContain('mystery-1');
    // 未定价模型显示「未定价」而不是 0
    expect(within(getByTestId('usage-breakdown-model')).getByTestId('usage-unpriced')).toBeTruthy();
    expect(
      getByTestId('usage-heatmap').querySelectorAll('[data-testid="usage-heat-cell"]'),
    ).toHaveLength(365);
  });

  it('切换时间范围会重新查询；切到 CNY 写设置并按汇率换算', async () => {
    const { findByTestId, getByRole, getAllByRole } = render(<UsagePanel />);
    await findByTestId('usage-card-cost');
    expect(queries()).toEqual(['7d']);
    fireEvent.click(getByRole('tab', { name: '30 天' }));
    await waitFor(() => expect(queries()).toContain('30d'));
    // 顶部币种切换
    const cny = getAllByRole('tab', { name: 'CNY' })[0]!;
    fireEvent.click(cny);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c[0] === 'ai:usage:set-settings' && (c[1] as { currency?: string }).currency === 'CNY',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        (document.querySelector('[data-testid="usage-card-cost"]') as HTMLElement).textContent,
      ).toContain('¥90.00'),
    );
  });

  it('检测到的工具显示友好名称（含 Qwen Code / OpenCode / Copilot CLI / Kimi）', async () => {
    install();
    (state as { detected: string[] }).detected = ['claude', 'qwen', 'opencode', 'copilot', 'kimi'];
    const { findByTestId, container } = render(<UsagePanel />);
    await findByTestId('usage-card-cost');
    const sub = container.querySelector('p')?.textContent ?? '';
    for (const n of ['Claude Code', 'Qwen Code', 'OpenCode', 'GitHub Copilot CLI', 'Kimi'])
      expect(sub).toContain(n);
    expect(sub).not.toContain('copilot,');
  });

  it('没有任何数据：复用 EmptyState，并可手动扫描', async () => {
    emptyData = true;
    install();
    const { findByTestId, getByText } = render(<UsagePanel />);
    const e = await findByTestId('usage-empty');
    expect(e.className).toContain('cd-empty');
    fireEvent.click(getByText('立即扫描本机日志'));
    await waitFor(() => expect(calls.some((c) => c[0] === 'ai:usage:scan')).toBe(true));
  });

  it('不在桌面环境：显示占位而不是报错', () => {
    delete (window as unknown as { aiIPC?: unknown }).aiIPC;
    const { getByText } = render(<UsagePanel />);
    expect(getByText('用量统计仅在桌面应用中提供')).toBeTruthy();
  });

  it('点热力图某一天：显示当日汇总，「查看当日明细」跳到明细并按当天过滤', async () => {
    const { findByTestId, getAllByTestId, getByTestId } = render(<UsagePanel />);
    await findByTestId('usage-heatmap');
    const cell = getAllByTestId('usage-heat-cell').find((c) =>
      /(?<!\d)[1-9]\d* tokens/.test(c.getAttribute('aria-label') ?? ''),
    )!;
    const date = cell.getAttribute('data-date')!;
    fireEvent.click(cell);
    expect(getByTestId('usage-day').textContent).toContain(date);
    fireEvent.click(getByTestId('usage-day-details'));
    await findByTestId('usage-details');
    await waitFor(() => {
      const q = calls.filter((c) => c[0] === 'ai:usage:details').at(-1)![1] as {
        from: number;
        to: number;
      };
      const [y, m, d] = date.split('-').map(Number) as [number, number, number];
      expect(q.from).toBe(new Date(y, m - 1, d).getTime());
      expect(q.to).toBe(new Date(y, m - 1, d + 1).getTime());
    });
  });
});

describe('UsagePanel 明细 / 价格', () => {
  it('明细：未定价与估算标记、排序、筛选、CSV 导出', async () => {
    const created: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => {
      created.push(b);
      return 'blob:x';
    };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    const { findByTestId, getByRole, getAllByTestId, getByTestId } = render(<UsagePanel />);
    await findByTestId('usage-card-cost');
    fireEvent.click(getByRole('tab', { name: '明细' }));
    await findByTestId('usage-details');
    await waitFor(() => expect(getAllByTestId('usage-row')).toHaveLength(2));
    const rows = getAllByTestId('usage-row');
    expect(rows[1]!.textContent).toContain('未定价');
    expect(rows[1]!.textContent).toContain('估算');
    expect(rows[0]!.textContent).toContain('$0.500');

    fireEvent.click(getByTestId('usage-sort-cost'));
    await waitFor(() => {
      const q = calls.filter((c) => c[0] === 'ai:usage:details').at(-1)![1] as {
        sort: string;
        dir: string;
      };
      expect(q.sort).toBe('cost');
      expect(q.dir).toBe('desc');
    });
    fireEvent.click(getByTestId('usage-sort-cost'));
    await waitFor(() => {
      const q = calls.filter((c) => c[0] === 'ai:usage:details').at(-1)![1] as { dir: string };
      expect(q.dir).toBe('asc');
    });

    fireEvent.click(getByTestId('usage-export'));
    await waitFor(() => expect(created).toHaveLength(1));
    const bytes = new Uint8Array(await new Response(created[0]).arrayBuffer());
    // UTF-8 BOM：Excel 直接打开不乱码
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csvCall = calls.find((c) => c[0] === 'ai:usage:csv')![1] as {
      limit: number;
      sort: string;
    };
    expect(csvCall.limit).toBeGreaterThan(1000);
  });

  it('价格：展示内置价格表；为未定价模型一键加行并保存', async () => {
    const { findByTestId, getByRole, getByTestId, getByText } = render(<UsagePanel />);
    await findByTestId('usage-card-cost');
    fireEvent.click(getByRole('tab', { name: '价格' }));
    await findByTestId('usage-pricing');
    expect(getByTestId('usage-builtin-table').textContent).toContain('Claude Sonnet 4.5');
    expect(getByTestId('usage-builtin-table').textContent).toContain('3.75');
    // 未定价模型提示：点一下加成一行
    fireEvent.click(within(getByTestId('usage-todo-prices')).getByText('mystery-1'));
    const row = getByTestId('usage-custom-row');
    fireEvent.change(within(row).getByTestId('usage-price-input'), { target: { value: '1.5' } });
    fireEvent.change(within(row).getByTestId('usage-price-output'), { target: { value: '0' } });
    fireEvent.click(getByTestId('usage-save-prices'));
    await waitFor(() => {
      const c = calls.find(
        (x) =>
          x[0] === 'ai:usage:set-settings' && (x[1] as { customPrices?: unknown }).customPrices,
      );
      expect((c![1] as { customPrices: unknown }).customPrices).toEqual([
        { model: 'mystery-1', input: 1.5, output: 0 },
      ]);
    });
    await waitFor(() => expect(getByText('已保存')).toBeTruthy());
  });

  it('价格：打开面板不联网；点「同步价格」才调用，并显示价格表日期 / 上次同步 / 隐私说明', async () => {
    const { findByTestId, getByRole, getByTestId } = render(<UsagePanel />);
    await findByTestId('usage-card-cost');
    fireEvent.click(getByRole('tab', { name: '价格' }));
    await findByTestId('usage-pricing');
    expect(getByTestId('usage-price-sync').textContent).toContain('不上传任何用量');
    expect(getByTestId('usage-sync-status').textContent).toContain('尚未同步');
    expect(calls.some((c) => c[0] === 'ai:usage:price-sync')).toBe(false);
    fireEvent.click(getByTestId('usage-sync-prices'));
    await waitFor(() =>
      expect(calls.filter((c) => c[0] === 'ai:usage:price-sync')).toHaveLength(1),
    );
    await waitFor(() => expect(getByTestId('usage-sync-result').textContent).toContain('321'));
    expect(getByTestId('usage-sync-status').textContent).toContain('2026-10-16');
    expect(getByTestId('usage-sync-status').textContent).toContain('321');
  });

  it('价格：同步失败时提示原因并说明继续使用已有价格', () => {
    expect(priceSyncMessage({ ok: false, reason: 'network' })).toContain('继续使用已有价格');
    expect(priceSyncMessage({ ok: true, status: 'not-modified', count: 3, skipped: 0 })).toContain(
      '最新',
    );
  });

  it('价格：缺少输入 / 输出价时拒绝保存并提示', async () => {
    const { findByTestId, getByRole, getByTestId, findByText } = render(<UsagePanel />);
    await findByTestId('usage-card-cost');
    fireEvent.click(getByRole('tab', { name: '价格' }));
    await findByTestId('usage-pricing');
    fireEvent.click(getByTestId('usage-add-price'));
    fireEvent.change(within(getByTestId('usage-custom-row')).getByPlaceholderText('model-name'), {
      target: { value: 'foo' },
    });
    fireEvent.click(getByTestId('usage-save-prices'));
    expect(await findByText(/价格需要是不小于 0 的数字/)).toBeTruthy();
    expect(
      calls.some(
        (c) =>
          c[0] === 'ai:usage:set-settings' && (c[1] as { customPrices?: unknown }).customPrices,
      ),
    ).toBe(false);
  });
});

describe('UsagePanel 预算与隐私', () => {
  const open = async () => {
    const r = render(<UsagePanel />);
    await r.findByTestId('usage-card-cost');
    fireEvent.click(r.getByRole('tab', { name: '预算与隐私' }));
    await r.findByTestId('usage-budget');
    return r;
  };
  const patches = () =>
    calls
      .filter((c) => c[0] === 'ai:usage:set-settings')
      .map((c) => c[1] as Record<string, unknown>);

  it('填预算：失焦保存；留空 = 0；非法值提示且不保存', async () => {
    const { getByTestId, findByText } = await open();
    const daily = getByTestId('usage-budget-daily') as HTMLInputElement;
    fireEvent.change(daily, { target: { value: '12.5' } });
    fireEvent.blur(daily);
    await waitFor(() => expect(patches()).toContainEqual({ dailyBudget: 12.5 }));
    fireEvent.change(getByTestId('usage-budget-task'), { target: { value: '3' } });
    fireEvent.keyDown(getByTestId('usage-budget-task'), { key: 'Enter' });
    await waitFor(() => expect(patches()).toContainEqual({ taskAlert: 3 }));
    // 清空 → 0
    fireEvent.change(daily, { target: { value: '' } });
    fireEvent.blur(daily);
    await waitFor(() => expect(patches()).toContainEqual({ dailyBudget: 0 }));
    // 非法
    const n = patches().length;
    fireEvent.change(getByTestId('usage-budget-monthly'), { target: { value: '-5' } });
    fireEvent.blur(getByTestId('usage-budget-monthly'));
    expect(await findByText(/金额需要是不小于 0 的数字/)).toBeTruthy();
    expect(patches()).toHaveLength(n);
  });

  it('币种符号随当前币种；已有预算回填输入框', async () => {
    state.settings.dailyBudget = 20;
    state.settings.currency = 'CNY';
    const { getByTestId } = await open();
    expect((getByTestId('usage-budget-daily') as HTMLInputElement).value).toBe('20');
    expect(getByTestId('usage-budget').textContent).toContain('¥');
  });

  it('隐私：总开关 / 读取日志开关 / 保留时长写入设置；总开关关闭时日志开关禁用', async () => {
    const { getByTestId } = await open();
    const logs = getByTestId('usage-read-logs') as HTMLInputElement;
    expect(logs.disabled).toBe(false);
    fireEvent.click(logs);
    await waitFor(() => expect(patches()).toContainEqual({ readToolLogs: false }));
    fireEvent.click(getByTestId('usage-enabled'));
    await waitFor(() => expect(patches()).toContainEqual({ enabled: false }));
    await waitFor(() =>
      expect((getByTestId('usage-read-logs') as HTMLInputElement).disabled).toBe(true),
    );
  });

  it('一键清空：确认后才清；取消不动；本地存储说明在页面上', async () => {
    const confirm = vi.fn();
    vi.stubGlobal('confirm', confirm);
    window.confirm = confirm;
    const { getByTestId } = await open();
    expect(getByTestId('usage-budget').textContent).toContain('不上传、不做云同步');
    confirm.mockReturnValueOnce(false);
    fireEvent.click(getByTestId('usage-clear'));
    expect(calls.some((c) => c[0] === 'ai:usage:clear')).toBe(false);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(getByTestId('usage-clear'));
    await waitFor(() => expect(calls.some((c) => c[0] === 'ai:usage:clear')).toBe(true));
    await waitFor(() =>
      expect((getByTestId('usage-clear') as HTMLButtonElement).disabled).toBe(true),
    );
    vi.unstubAllGlobals();
  });
});

describe('UsagePanel 订阅额度 · 安全刷新', () => {
  it('卡片标出隐私说明；刷新按钮只在点击时调用 quota-refresh（打开面板不会触发）', async () => {
    const { findByTestId, getByTestId } = render(<UsagePanel />);
    await findByTestId('usage-quota-card');
    const priv = getByTestId('usage-quota-privacy').textContent ?? '';
    expect(priv).toContain('不读取、不保存、不上传任何登录凭据');
    expect(priv).toContain('auth.json');
    expect(priv).toContain('Codex 会因此向 OpenAI 发一次请求');
    expect(priv).toContain('不会自动轮询');
    expect(calls.some((c) => c[0] === 'ai:usage:quota-refresh')).toBe(false);
    fireEvent.click(getByTestId('usage-quota-refresh'));
    await waitFor(() =>
      expect(calls.filter((c) => c[0] === 'ai:usage:quota-refresh')).toHaveLength(1),
    );
  });

  it('刷新结果：显示来源、「上次读取」标记，以及每个工具的结果说明', async () => {
    const now = Date.now();
    refreshEntries = [
      {
        id: 'claude',
        label: 'Claude Code',
        status: 'ok',
        auth: 'subscription',
        origin: 'usage-cmd',
        plan: 'Max',
        updatedAt: now,
        windows: [
          { id: 'five_hour', usedPercent: 12, windowMinutes: 300, resetAt: now + 3_600_000 },
        ],
      },
      {
        id: 'codex',
        label: 'Codex',
        status: 'ok',
        auth: 'subscription',
        origin: 'app-server',
        stale: true,
        updatedAt: now - 600_000,
        windows: [{ id: 'primary', usedPercent: 33, windowMinutes: 300 }],
      },
    ];
    refreshTools = {
      claude: { state: 'ok' },
      codex: { state: 'transient', reason: 'timeout', stale: true },
    };
    const { findByTestId, getByTestId } = render(<UsagePanel />);
    await findByTestId('usage-quota-card');
    fireEvent.click(getByTestId('usage-quota-refresh'));
    const notes = await findByTestId('usage-quota-notes');
    expect(notes.textContent).toContain('Claude Code：已让官方 CLI（claude -p /usage）刷新。');
    expect(notes.textContent).toContain('显示的是上次读到的值');
    expect(getByTestId('usage-quota-origin-claude').textContent).toContain('claude /usage');
    expect(getByTestId('usage-quota-origin-codex').textContent).toContain('codex app-server');
    expect(getByTestId('usage-quota-codex').textContent).toContain('上次读取');
    expect(getByTestId('usage-quota-claude').textContent).not.toContain('上次读取');
  });

  it('各种结果说明：认证失效 / 节流 / 本机数据够新 / 已关闭主动刷新 / 版本不支持', async () => {
    refreshTools = {
      claude: { state: 'auth', reason: 'denied' },
      codex: { state: 'throttled', retryInSec: 42 },
    };
    const { findByTestId, getByTestId } = render(<UsagePanel />);
    await findByTestId('usage-quota-card');
    fireEvent.click(getByTestId('usage-quota-refresh'));
    let notes = await findByTestId('usage-quota-notes');
    expect(notes.textContent).toContain('已清除旧额度');
    expect(notes.textContent).toContain('42 秒后可再次刷新');

    refreshTools = {
      claude: { state: 'transient', reason: 'unsupported', stale: false },
      codex: { state: 'skipped', reason: 'disabled' },
    };
    fireEvent.click(getByTestId('usage-quota-refresh'));
    await waitFor(() =>
      expect(getByTestId('usage-quota-notes').textContent).toContain('不支持非交互读取额度'),
    );
    notes = getByTestId('usage-quota-notes');
    expect(notes.textContent).toContain('已关闭「主动刷新额度」');

    refreshTools = { claude: { state: 'fresh-local' } };
    fireEvent.click(getByTestId('usage-quota-refresh'));
    await waitFor(() =>
      expect(getByTestId('usage-quota-notes').textContent).toContain('没有拉起官方 CLI'),
    );
  });

  it('设置里的「主动刷新额度」开关写入设置', async () => {
    const { getByRole, findByTestId } = render(<UsagePanel />);
    await findByTestId('usage-quota-card');
    fireEvent.click(getByRole('tab', { name: '预算与隐私' }));
    const sw = await findByTestId('usage-active-quota');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c[0] === 'ai:usage:set-settings' &&
            (c[1] as { activeQuotaRefresh?: boolean }).activeQuotaRefresh === false,
        ),
      ).toBe(true),
    );
  });

  it('API 计费的工具仍显示「API 计费，无订阅额度」', async () => {
    quota = [
      { id: 'claude', label: 'Claude Code', status: 'api', auth: 'api', windows: [] },
      { id: 'codex', label: 'Codex', status: 'api', auth: 'api', windows: [] },
    ];
    const { findByTestId, getByTestId } = render(<UsagePanel />);
    await findByTestId('usage-quota-card');
    expect(getByTestId('usage-quota-claude').getAttribute('data-status')).toBe('api');
    expect(getByTestId('usage-quota-claude').textContent).toContain('API 计费，无订阅额度');
  });
});

describe('UsagePanel 订阅额度', () => {
  it('没有可用额度：每个工具都写「暂未返回可用额度」，不显示任何百分比', async () => {
    const { findByTestId, getByTestId } = render(<UsagePanel />);
    const card = await findByTestId('usage-quota-card');
    expect(getByTestId('usage-quota-codex').getAttribute('data-status')).toBe('unavailable');
    expect(card.textContent?.match(/暂未返回可用额度/g)).toHaveLength(2);
    expect(card.querySelector('[role="progressbar"]')).toBeNull();
    expect(card.textContent).not.toMatch(/已用 \d/);
  });

  it('有额度快照：显示窗口、已用百分比与重置时间；重置时间已过的窗口不显示百分比', async () => {
    const now = Date.now();
    quota = [
      {
        id: 'codex',
        label: 'Codex',
        status: 'ok',
        plan: 'plus',
        updatedAt: now - 120_000,
        windows: [
          { id: 'primary', usedPercent: 42, windowMinutes: 300, resetAt: now + 2 * 3_600_000 },
          {
            id: 'secondary',
            usedPercent: 80,
            windowMinutes: 10080,
            resetAt: now - 1000,
            expired: true,
          },
        ],
      },
      { id: 'claude', label: 'Claude Code', status: 'unavailable', windows: [] },
    ];
    const { findByTestId, getAllByTestId } = render(<UsagePanel />);
    const card = await findByTestId('usage-quota-card');
    const wins = getAllByTestId('usage-quota-window');
    expect(wins).toHaveLength(2);
    expect(wins[0]!.textContent).toContain('5 小时窗口');
    expect(wins[0]!.textContent).toContain('已用 42%');
    expect(wins[0]!.textContent).toContain('约 2 小时后重置');
    expect(wins[0]!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe(
      '42',
    );
    expect(wins[1]!.textContent).toContain('每周窗口');
    expect(wins[1]!.textContent).toContain('窗口已重置');
    expect(wins[1]!.textContent).not.toContain('80%');
    expect(card.textContent).toContain('plus');
    expect(card.textContent?.match(/暂未返回可用额度/g)).toHaveLength(1); // 只剩 Claude Code
  });

  it('额度接口出错：卡片不显示，不影响其它内容', async () => {
    quota = [];
    const { findByTestId, queryByTestId } = render(<UsagePanel />);
    await findByTestId('usage-card-cost');
    expect(queryByTestId('usage-quota-card')?.textContent ?? '').not.toMatch(/已用/);
  });
});

describe('UsagePanel 订阅额度：按登录方式区分', () => {
  const E = (id: string, status: string, auth: string, extra: object = {}) => ({
    id,
    label: id,
    status,
    auth,
    windows: [],
    ...extra,
  });

  it('API Key / 第三方供应商的工具：只写「API 计费，无订阅额度」，没有额度条也没有「暂未返回」', async () => {
    quota = [E('claude', 'api', 'api'), E('codex', 'api', 'api'), E('dsh', 'api', 'api')];
    const { findByTestId, getByTestId } = render(<UsagePanel />);
    const card = await findByTestId('usage-quota-card');
    expect(getByTestId('usage-quota-dsh').getAttribute('data-status')).toBe('api');
    expect(card.textContent?.match(/API 计费，无订阅额度/g)).toHaveLength(3);
    expect(card.textContent).not.toContain('暂未返回可用额度');
    expect(card.querySelector('[role="progressbar"]')).toBeNull();
    // API 登录不需要 Claude 钩子
    expect(card.querySelector('[data-testid="usage-quota-hook"]')).toBeNull();
    expect(card.querySelector('[data-testid="usage-quota-nomi"]')).toBeNull();
  });

  it('订阅登录的 Claude 暂无额度：给出开启状态栏快照的选项；开启后按钮变为「关闭并恢复」', async () => {
    quota = [
      E('codex', 'ok', 'subscription', {
        plan: 'plus',
        windows: [{ id: 'primary', usedPercent: 10, windowMinutes: 300 }],
      }),
      E('claude', 'unavailable', 'subscription'),
      E('dsh', 'api', 'api'),
    ];
    const { findByTestId, getByTestId, queryByTestId } = render(<UsagePanel />);
    const box = await findByTestId('usage-quota-hook');
    expect(box.textContent).toContain('不读取凭据');
    expect(getByTestId('usage-quota-claude').textContent).toContain('暂未返回可用额度');
    expect(queryByTestId('usage-hook-off')).toBeNull();
    fireEvent.click(getByTestId('usage-hook-on'));
    await waitFor(() =>
      expect(calls.some((c) => c[0] === 'ai:usage:quota-hook-set' && c[1] === true)).toBe(true),
    );
    const off = await findByTestId('usage-hook-off');
    expect(getByTestId('usage-quota-hook').textContent).toContain('等 Claude Code 完成一次回复');
    fireEvent.click(off);
    await waitFor(() =>
      expect(calls.some((c) => c[0] === 'ai:usage:quota-hook-set' && c[1] === false)).toBe(true),
    );
    await findByTestId('usage-hook-on');
  });

  it('Claude 通过状态栏快照拿到额度：展示 5 小时 / 每周窗口', async () => {
    const now = Date.now();
    hook = { supported: true, enabled: true, hadOwnStatusLine: true, hasSnapshot: true };
    quota = [
      E('claude', 'ok', 'subscription', {
        updatedAt: now - 60_000,
        windows: [
          { id: 'five_hour', usedPercent: 23.5, windowMinutes: 300, resetAt: now + 3_600_000 },
          {
            id: 'seven_day',
            usedPercent: 41.2,
            windowMinutes: 10080,
            resetAt: now + 86_400_000 * 3,
          },
        ],
      }),
    ];
    const { findByTestId, getAllByTestId } = render(<UsagePanel />);
    const card = await findByTestId('usage-quota-card');
    const wins = getAllByTestId('usage-quota-window');
    expect(wins.map((w) => w.textContent)).toEqual([
      expect.stringContaining('5 小时窗口'),
      expect.stringContaining('每周窗口'),
    ]);
    expect(wins[0]!.textContent).toContain('已用 24%');
    await findByTestId('usage-hook-off');
    expect(card.textContent).toContain('你原来的状态栏命令照常运行');
  });

  it('settings.json 不合法 / Windows：说明原因，不给开启按钮', async () => {
    quota = [E('claude', 'unavailable', 'subscription')];
    hook = {
      supported: true,
      enabled: false,
      hadOwnStatusLine: false,
      hasSnapshot: false,
      problem: 'invalid-settings',
    };
    const first = render(<UsagePanel />);
    expect((await first.findByTestId('usage-quota-hook')).textContent).toContain('不是合法的 JSON');
    expect(first.queryByTestId('usage-hook-on')).toBeNull();
    first.unmount();
    hook = { supported: false, enabled: false, hadOwnStatusLine: false, hasSnapshot: false };
    const second = render(<UsagePanel />);
    expect((await second.findByTestId('usage-quota-hook')).textContent).toContain('Windows');
    expect(second.queryByTestId('usage-hook-on')).toBeNull();
  });

  it('没有任何订阅登录的工具：提示而不是空卡片，也没有「暂未返回」', async () => {
    quota = [];
    const { findByTestId } = render(<UsagePanel />);
    const empty = await findByTestId('usage-quota-empty');
    expect(empty.textContent).toContain('没有检测到');
    expect((await findByTestId('usage-quota-card')).textContent).not.toContain('暂未返回可用额度');
  });
});
