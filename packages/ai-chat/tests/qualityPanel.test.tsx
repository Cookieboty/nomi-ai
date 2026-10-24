// @vitest-environment happy-dom
/**
 * 设置 → 模型质量（docs/design/model-quality.md §5）：工具栏（筛选芯片、层级、口径、设置）、
 * 多级对比表（展开、勾选并排对比、分页、钻取）、趋势、请求明细、空状态。
 */
import type {
  QualityQuery,
  QualityRecord,
  QualityRequestsQuery,
  QualitySeriesQuery,
  QualityStats,
} from '@nomi-ai/types';
import { cleanup, configure, fireEvent, render, waitFor, within } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QualityPanel, type QualityTab } from '../src/components/QualityPanel';
import { MAX_COMPARE } from '../src/components/QualityPanel/CompareTable';
import { PAGE_SIZE } from '../src/components/QualityPanel/RequestDetails';

configure({ asyncUtilTimeout: 10_000 });

const NOW = new Date(2026, 9, 24, 15, 0, 0).getTime();

const dist = (n: number, p50: number) => ({
  n,
  mean: p50,
  p50,
  p90: p50 * 2,
  p95: p50 * 2.5,
  p99: p50 * 3,
});

function stats(key: string, over: Partial<QualityStats> = {}): QualityStats {
  return {
    key,
    label: key,
    requests: 100,
    attempts: 110,
    total: 110,
    ok: 96,
    failed: 6,
    clientErrors: 2,
    cancelled: 4,
    cancelBeforeFirst: 1,
    cancelDuring: 3,
    streamBreak: 2,
    fallback: 5,
    burst: 0,
    successRate: 0.9846,
    failureRate: 0.0615,
    cancelRate: 0.04,
    streamBreakRate: 0.02,
    fallbackRate: 0.05,
    cacheHitTokenRate: 0.7615,
    cacheHitRequestRate: 0.6,
    failures: { 'stream-break': 2, 'rate-limit': 3, auth: 1 },
    ttfb: dist(100, 400),
    ttft: dist(100, 1200),
    ttftText: dist(100, 1500),
    tpot: dist(100, 30),
    e2e: dist(100, 6000),
    outputTps: dist(100, 45),
    inputLen: dist(100, 88_790),
    tokens: { input: 50_000, output: 8_000, cacheRead: 21_000, cacheWrite: 0, reasoning: 0 },
    cost: 1.2,
    ...over,
  };
}

/** 模型族 → 供应商 → Key 的树；顶层 12 个模型（测分页） */
function tree(path: string[]): QualityStats[] {
  const second = (prefix: string): QualityStats[] =>
    path[1] === 'provider'
      ? [
          stats('amux', {
            dim: 'provider',
            label: 'Amux Special',
            tag: 'thirdParty',
            ...(path[2] === 'key'
              ? { children: [stats('amux\u0000k1', { dim: 'key', label: 'k1' })] }
              : {}),
          }),
          stats('azure', {
            dim: 'provider',
            label: 'Microsoft Azure',
            tag: 'official',
            successRate: 0.9999,
          }),
        ]
      : path[1] === 'client'
        ? [stats('claude', { dim: 'client' }), stats(`codex-${prefix}`, { dim: 'client' })]
        : [stats('x', { dim: path[1] as never })];
  const models = [
    stats('gpt-6.1-sol', {
      dim: 'modelFamily',
      vendor: 'OpenAI',
      display: 'GPT-6.1 Sol',
      total: 78_080,
      ok: 76_520,
      failed: 1200,
      clientErrors: 356,
      streamBreak: 4,
    }),
    stats('gemini-3.8-flash', {
      dim: 'modelFamily',
      vendor: 'Google',
      display: 'Gemini 3.8 Flash',
      successRate: 0.8366,
      streamBreak: 0,
    }),
    ...Array.from({ length: 10 }, (_, i) =>
      stats(`m${i}`, { dim: 'modelFamily', display: `Model ${i}`, total: 100 - i }),
    ),
  ];
  return models.map((m) => ({ ...m, children: second(m.key) }));
}

function record(i: number, over: Partial<QualityRecord> = {}): QualityRecord {
  return {
    id: `r${i}`,
    layer: 'gateway',
    ts: NOW - i * 60_000,
    client: 'claude',
    source: 'thirdParty',
    provider: 'amux',
    keyId: 'k1',
    model: 'amux/openai/gpt-6.1-sol',
    ingress: 'messages',
    wire: 'responses',
    mode: 'convert',
    resolved: 'binding',
    stream: true,
    outcome: 'ok',
    status: 200,
    timing: { headersMs: 300, firstContentMs: 900, lastContentMs: 4000, endMs: 4100 },
    tokens: { input: 1000, output: 200, cacheRead: 600 },
    tabId: 'tab-7f3a91c2d4',
    generation: 2,
    traceId: 'abc123def456',
    notes: ['temperature 已去掉（模型只接受默认温度）'],
    ...over,
  };
}

let calls: Array<[string, unknown]> = [];
let gatewayEmpty = false;
let cliHasData = true;
let total = 120;
let seriesPoints = 3;

function install() {
  calls = [];
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: vi.fn(async (ch: string, arg?: unknown) => {
      calls.push([ch, arg]);
      switch (ch) {
        case 'ai:quality:query': {
          const q = arg as QualityQuery;
          const empty =
            (q.layer ?? 'gateway') === 'gateway'
              ? gatewayEmpty || !!q.filters?.provider?.includes('none')
              : !cliHasData;
          if (empty)
            return { total: stats('*', { requests: 0, total: 0 }), groups: [], minSamples: 20 };
          return {
            total: stats('*'),
            groups: q.groupPath ? tree(q.groupPath) : [],
            minSamples: 20,
            ...(q.withPrevious ? { previous: stats('*', { successRate: 0.95, total: 80 }) } : {}),
          };
        }
        case 'ai:quality:facets':
          return {
            client: [
              { key: 'claude', label: 'claude', count: 80 },
              { key: 'codex', label: 'codex', count: 20 },
            ],
            provider: [
              { key: 'amux', label: 'Amux Special', count: 70 },
              { key: 'azure', label: 'Microsoft Azure', count: 30 },
            ],
            modelFamily: [
              { key: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', count: 90, vendor: 'OpenAI' },
            ],
            key: [{ key: 'amux\u0000k1', label: 'Amux Special · k1', count: 70 }],
          };
        case 'ai:quality:series': {
          const q = arg as QualitySeriesQuery;
          const buckets = [0, 1, 2].map((i) => NOW - (2 - i) * 86_400_000);
          const vals = [0.9, 0.92, 0.95].map((v, i) => (i < seriesPoints ? v : null));
          return {
            buckets,
            series: Array.from({ length: q.groupBy ? 2 : 1 }, (_, i) => ({
              key: `s${i}`,
              label: `Series ${i}`,
              values: vals,
            })),
          };
        }
        case 'ai:quality:requests': {
          const q = arg as QualityRequestsQuery;
          const off = q.offset ?? 0;
          const n = Math.max(0, Math.min(q.limit, total - off));
          return {
            total,
            items: Array.from({ length: n }, (_, i) =>
              i === 0 && off === 0
                ? record(0, {
                    outcome: 'stream-break',
                    errorKind: 'upstream closed without terminal event',
                    attempts: [
                      {
                        provider: 'ds',
                        keyId: 'k9',
                        model: 'ds/v4',
                        outcome: 'rate-limit',
                        status: 429,
                        ms: 120,
                      },
                      {
                        provider: 'amux',
                        keyId: 'k1',
                        model: 'amux/openai/gpt-6.1-sol',
                        outcome: 'stream-break',
                        status: 200,
                        ms: 4100,
                      },
                    ],
                  })
                : record(off + i),
            ),
          };
        }
        case 'ai:quality:settings-get':
          return { retentionDays: 30 };
        case 'ai:quality:settings-set':
          return { retentionDays: (arg as { retentionDays: number }).retentionDays };
        case 'ai:quality:export':
          return { ok: true, path: '/tmp/quality.csv', rows: 3 };
        case 'ai:quality:clear':
          return undefined;
      }
      return null;
    }),
    on: vi.fn(() => () => undefined),
  };
}

beforeEach(() => {
  gatewayEmpty = false;
  cliHasData = true;
  total = 120;
  seriesPoints = 3;
  install();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

const last = <T,>(ch: string): T => calls.filter((c) => c[0] === ch).at(-1)![1] as T;

const Harness: React.FC<{ start?: QualityTab | 'overview' }> = ({ start = 'compare' }) => {
  const [tab, setTab] = useState<QualityTab | 'overview'>(start);
  return <QualityPanel tab={tab} onTab={setTab} now={() => NOW} />;
};

const openChip = (r: ReturnType<typeof render>, id: string) => {
  fireEvent.click(r.getByTestId(id));
  return r.getByTestId(`${id}-panel`);
};

describe('对比（默认）', () => {
  it('打开就是多级对比表：指标卡、计数说明与统计区间、按尝试计、模型 → 供应商 → Key', async () => {
    const r = render(<Harness start="overview" />);
    await r.findByTestId('quality-tree');
    expect(r.getByTestId('quality-kpis').textContent).toContain('98.46%');
    expect(r.getByTestId('quality-count-note').textContent).toContain('按上游尝试计');
    expect(r.getByTestId('quality-range-note').textContent).toMatch(
      /统计区间 10\/\d+ \d\d:\d\d – 10\/24 15:00/,
    );
    const q = last<QualityQuery>('ai:quality:query');
    expect(q).toMatchObject({
      groupPath: ['modelFamily', 'provider', 'key'],
      countBy: 'attempt',
      withPrevious: true,
    });
    const rows = r.getAllByTestId('quality-row');
    expect(rows).toHaveLength(10);
    expect(within(rows[0]!).getByTestId('quality-row-name').textContent).toBe(
      'OpenAI: GPT-6.1 Sol',
    );
    // 数字格式：78.08K、1.2K；失败标红、流中断标橙、成功率低于 95% 标红
    const cell = (row: HTMLElement, col: string) => row.querySelector(`[data-col="${col}"]`)!;
    expect(cell(rows[0]!, 'total').textContent).toBe('78.08K');
    expect(cell(rows[0]!, 'failed').textContent).toBe('1.2K');
    expect(cell(rows[0]!, 'failed').className).toMatch(/toneDanger/);
    expect(cell(rows[0]!, 'streamBreak').className).toMatch(/toneWarning/);
    expect(cell(rows[1]!, 'successRate').textContent).toBe('83.66%');
    expect(cell(rows[1]!, 'successRate').className).toMatch(/toneDanger/);
    expect(cell(rows[0]!, 'inputLen.p50').textContent).toBe('88.79K');
  });

  it('展开 / 收起：子级显示供应商与「官方」标记，再展开到 Key；键盘 → 展开', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    const toggle = r.getAllByTestId('quality-row-toggle')[0]!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(toggle, { key: 'ArrowRight' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const names = () => r.getAllByTestId('quality-row-name').map((n) => n.textContent);
    expect(names().slice(0, 3)).toEqual(['OpenAI: GPT-6.1 Sol', 'Amux Special', 'Microsoft Azure']);
    expect(r.getAllByTestId('quality-row')[2]!.textContent).toContain('官方');
    fireEvent.click(r.getAllByTestId('quality-row-toggle')[1]!);
    expect(names()[2]).toBe('k1');
    fireEvent.click(toggle);
    expect(names().slice(0, 2)).toEqual(['OpenAI: GPT-6.1 Sol', 'Google: Gemini 3.8 Flash']);
  });

  it('层级预设改写查询；CLI 层去掉 Key 层级与 Key 筛选', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    expect(r.getByTestId('quality-hierarchy').textContent).toContain('层级：模型 → 供应商 → Key');
    openChip(r, 'quality-hierarchy');
    fireEvent.click(r.getByTestId('quality-hierarchy-menu-model-client-provider'));
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').groupPath).toEqual([
        'modelFamily',
        'client',
        'provider',
      ]),
    );
    expect(r.queryByTestId('quality-hierarchy-panel')).toBeNull();
    openChip(r, 'quality-hierarchy');
    fireEvent.click(r.getByTestId('quality-hierarchy-menu-model-provider-key'));
    fireEvent.click(r.getByTestId('quality-layer-cli'));
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query')).toMatchObject({
        layer: 'cli',
        groupPath: ['modelFamily', 'provider'],
        countBy: 'request',
      }),
    );
    expect(r.queryByTestId('quality-filter-key')).toBeNull();
    expect(r.getByTestId('quality-count-note').textContent).toContain('CLI 层按每一轮计');
  });

  it('勾选 2 项后并排对比（带最佳标记）；最多 4 项', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    const checks = r.getAllByTestId('quality-row-check') as HTMLInputElement[];
    fireEvent.click(checks[0]!);
    expect(r.getByTestId('quality-compare-open')).toHaveProperty('disabled', true);
    fireEvent.click(checks[1]!);
    fireEvent.click(r.getByTestId('quality-compare-open'));
    const panel = r.getByTestId('quality-compare');
    expect(panel.textContent).toContain('OpenAI: GPT-6.1 Sol');
    expect(panel.textContent).toContain('Google: Gemini 3.8 Flash');
    // 每个指标最好的一项带星标（屏幕阅读器读作「最佳」）
    expect(panel.textContent).toContain('最佳');
    for (let i = 2; i < MAX_COMPARE; i++) fireEvent.click(checks[i]!);
    expect(checks[MAX_COMPARE]!.disabled).toBe(true);
    fireEvent.click(r.getByTestId('quality-compare-close'));
    expect(r.queryByTestId('quality-compare')).toBeNull();
  });

  it('顶层行分页：每页 10 项，下一页、每页条数', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    expect(r.getByTestId('quality-page').textContent).toBe('显示第 1–10 项，共 12 项');
    fireEvent.click(r.getByTestId('quality-page-next'));
    expect(r.getAllByTestId('quality-row')).toHaveLength(2);
    expect(r.getByTestId('quality-page').textContent).toBe('显示第 11–12 项，共 12 项');
  });

  it('点「失败」钻取到请求明细：带上这一行的模型与失败结果', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    fireEvent.click(r.getAllByTestId('quality-drill-failed')[0]!);
    await r.findByTestId('quality-requests');
    const q = last<QualityRequestsQuery>('ai:quality:requests');
    expect(q.filters?.modelFamily).toEqual(['gpt-6.1-sol']);
    expect(q.filters?.outcome).toContain('stream-break');
    expect(q.filters?.outcome).not.toContain('ok');
    expect(r.getByTestId('quality-active-filters').textContent).toContain('GPT-6.1 Sol');
  });

  it('列分组可以收起', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    expect(
      r.getAllByTestId('quality-row')[0]!.querySelector('[data-col="ttft.p95"]'),
    ).not.toBeNull();
    openChip(r, 'quality-columns');
    fireEvent.click(r.getByTestId('quality-columns-latency'));
    expect(r.getAllByTestId('quality-row')[0]!.querySelector('[data-col="ttft.p95"]')).toBeNull();
  });
});

describe('工具栏', () => {
  it('筛选芯片：多选写进查询，芯片显示选择；下方出现可移除的筛选与「清除全部」', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    expect(r.queryByTestId('quality-active-filters')).toBeNull();
    const panel = openChip(r, 'quality-filter-client');
    const opts = within(panel).getAllByTestId('quality-filter-client-list-opt');
    fireEvent.click(opts[0]!);
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').filters?.client).toEqual(['claude']),
    );
    expect(r.getByTestId('quality-filter-client').textContent).toContain('客户端：Claude Code');
    fireEvent.click(opts[1]!);
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').filters?.client).toEqual(['claude', 'codex']),
    );
    expect(r.getByTestId('quality-filter-client').textContent).toContain('+1');
    const provider = openChip(r, 'quality-filter-provider');
    fireEvent.click(within(provider).getAllByTestId('quality-filter-provider-list-opt')[0]!);
    expect(r.getByTestId('quality-active-filters').textContent).toContain('Amux Special');
    fireEvent.click(r.getByTestId('quality-remove-provider'));
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').filters?.provider).toBeUndefined(),
    );
    fireEvent.click(r.getByTestId('quality-clear-filters'));
    await waitFor(() => expect(last<QualityQuery>('ai:quality:query').filters).toBeUndefined());
    expect(r.queryByTestId('quality-active-filters')).toBeNull();
    expect(r.getByTestId('quality-filter-client').textContent).toBe('客户端');
  });

  it('弹层：Esc 关闭，焦点回到芯片', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    const chip = r.getByTestId('quality-filter-client');
    const panel = openChip(r, 'quality-filter-client');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(r.queryByTestId('quality-filter-client-panel')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('「口径」：按请求 / 按尝试与两个开关写进查询', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    const panel = openChip(r, 'quality-count');
    fireEvent.click(within(panel).getByText('按请求'));
    fireEvent.click(r.getByTestId('quality-cancel-denom'));
    fireEvent.click(r.getByTestId('quality-include-rejected'));
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query')).toMatchObject({
        countBy: 'request',
        cancelInDenominator: true,
        includeRejected: true,
      }),
    );
    expect(r.getByTestId('quality-count-note').textContent).toContain('各列都按请求计');
  });

  it('自定义时间：弹出日期，改了就重新查询', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    fireEvent.click(r.getByTestId('quality-range-custom'));
    const panel = r.getByTestId('quality-custom-panel');
    fireEvent.change(within(panel).getByTestId('quality-from'), {
      target: { value: '2026-10-20' },
    });
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').from).toBe(new Date(2026, 9, 20).getTime()),
    );
  });

  it('导出：对比导出分组表，请求明细导出请求', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    fireEvent.click(r.getByTestId('quality-export'));
    await waitFor(() =>
      expect(last<{ kind: string; query: QualityQuery }>('ai:quality:export')).toMatchObject({
        kind: 'table',
        query: { groupPath: ['modelFamily', 'provider', 'key'] },
      }),
    );
    expect((await r.findByTestId('quality-export-msg')).textContent).toContain('/tmp/quality.csv');
  });

  it('设置弹层：保留天数、正文追踪状态、清空要确认', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    const panel = openChip(r, 'quality-settings');
    await waitFor(() =>
      expect(within(panel).getByRole('radio', { name: '30 天' }).getAttribute('aria-checked')).toBe(
        'true',
      ),
    );
    fireEvent.click(within(panel).getByRole('radio', { name: '90 天' }));
    await waitFor(() =>
      expect(last<{ retentionDays: number }>('ai:quality:settings-set').retentionDays).toBe(90),
    );
    fireEvent.click(within(panel).getByTestId('quality-clear'));
    expect(calls.some((c) => c[0] === 'ai:quality:clear')).toBe(false);
    fireEvent.click(within(panel).getByTestId('quality-clear-confirm'));
    await waitFor(() => expect(calls.some((c) => c[0] === 'ai:quality:clear')).toBe(true));
  });
});

describe('空状态', () => {
  it('网关层没数据、CLI 层有：提示切到 CLI 层', async () => {
    gatewayEmpty = true;
    const r = render(<Harness />);
    const notice = await r.findByTestId('quality-empty-official');
    expect(notice.textContent).toContain('CLI 层有记录');
    fireEvent.click(r.getByTestId('quality-switch-cli'));
    await waitFor(() => expect(last<QualityQuery>('ai:quality:query').layer).toBe('cli'));
  });

  it('两层都没数据：按口径说明（网关层包含 Nomi 对话）', async () => {
    gatewayEmpty = true;
    cliHasData = false;
    const r = render(<Harness />);
    const empty = await r.findByTestId('quality-empty');
    expect(empty.textContent).toContain('网关层还没有请求');
    expect(empty.textContent).toContain('Nomi 对话');
  });

  it('筛选后没数据：「没有匹配筛选条件」+ 清除筛选', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-tree');
    // 选一个不存在的供应商（测试桩对 provider=none 返回空）
    (
      window as unknown as { aiIPC: { invoke: ReturnType<typeof vi.fn> } }
    ).aiIPC.invoke.mockImplementationOnce(async () => ({
      client: [],
      provider: [{ key: 'none', label: 'none', count: 1 }],
    }));
    const panel = openChip(r, 'quality-filter-provider');
    const none = within(panel).queryAllByTestId('quality-filter-provider-list-opt');
    fireEvent.click(none[0]!);
    const empty = await r.findByTestId('quality-empty');
    expect(empty.textContent).toContain('没有匹配筛选条件的数据');
    fireEvent.click(r.getByTestId('quality-empty-clear'));
    await r.findByTestId('quality-tree');
  });
});

describe('趋势', () => {
  it('画折线；控件改写查询', async () => {
    const r = render(<Harness start="trend" />);
    await r.findByTestId('quality-line-chart');
    fireEvent.change(r.getByTestId('quality-trend-metric'), { target: { value: 'ttft.p95' } });
    await waitFor(() =>
      expect(last<QualitySeriesQuery>('ai:quality:series').metric).toBe('ttft.p95'),
    );
    expect(last<QualitySeriesQuery>('ai:quality:series').groupBy).toBe('modelFamily');
    fireEvent.click(r.getByTestId('quality-trend-view-table'));
    expect(r.getByTestId('quality-series-table')).toBeTruthy();
  });

  it('不足两个时段有数据：不画空图，给出说明', async () => {
    seriesPoints = 1;
    const r = render(<Harness start="trend" />);
    const empty = await r.findByTestId('quality-trend-empty');
    expect(empty.textContent).toContain('数据点不够画趋势');
    expect(r.queryByTestId('quality-line-chart')).toBeNull();
  });
});

describe('请求明细', () => {
  it('日志式表格：结果、模型、供应商 / Key、客户端与标签、时间线；展开看尝试、修正、追踪 id', async () => {
    const r = render(<Harness start="requests" />);
    const rows = await r.findAllByTestId('quality-request');
    expect(rows).toHaveLength(PAGE_SIZE);
    const first = rows[0]!;
    expect(within(first).getByTestId('quality-request-outcome').textContent).toContain('断流');
    expect(within(first).getByTestId('quality-request-fallback')).toBeTruthy();
    expect(first.textContent).toContain('openai/gpt-6.1-sol');
    expect(within(first).getByTestId('quality-request-tab').textContent).toContain('标签 tab-7f3a');
    expect(within(first).getByTestId('quality-timeline').getAttribute('aria-label')).toContain(
      '首字节',
    );
    fireEvent.click(within(first).getByTestId('quality-request-toggle'));
    expect(r.getByTestId('quality-request-attempts').querySelectorAll('li')).toHaveLength(2);
    expect(r.getByTestId('quality-request-trace').textContent).toBe('abc123def456');
    expect(r.getByTestId('quality-request-notes').textContent).toBe(
      'temperature 已去掉（模型只接受默认温度）',
    );
    expect(r.getByTestId('quality-request-resolved').textContent).toBe('标签选的模型');
  });

  it('分页、按结果筛选、导出请求', async () => {
    const r = render(<Harness start="requests" />);
    await r.findAllByTestId('quality-request');
    expect(r.getByTestId('quality-page').textContent).toBe('显示第 1–50 条，共 120 条');
    fireEvent.click(r.getByTestId('quality-page-next'));
    await waitFor(() => expect(last<QualityRequestsQuery>('ai:quality:requests').offset).toBe(50));
    fireEvent.change(r.getByTestId('quality-filter-outcome'), { target: { value: 'rate-limit' } });
    await waitFor(() =>
      expect(last<QualityRequestsQuery>('ai:quality:requests').filters?.outcome).toEqual([
        'rate-limit',
      ]),
    );
    expect(r.getByTestId('quality-active-filters').textContent).toContain('限流');
    fireEvent.click(r.getByTestId('quality-export'));
    await waitFor(() => expect(last<{ kind: string }>('ai:quality:export').kind).toBe('requests'));
  });

  it('没有请求：紧凑的空状态', async () => {
    total = 0;
    const r = render(<Harness start="requests" />);
    const empty = await r.findByTestId('quality-empty');
    expect(empty.textContent).toContain('网关层还没有请求');
  });
});

it('不在桌面环境：显示占位而不是报错', () => {
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
  const r = render(<Harness />);
  expect(r.getByText('模型质量仅在桌面应用中提供')).toBeTruthy();
});
