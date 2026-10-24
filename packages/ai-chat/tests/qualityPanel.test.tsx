// @vitest-environment happy-dom
/**
 * 设置 → 模型质量（docs/design/model-quality.md）：总览 / 对比 / 趋势 / 请求明细、钻取、空状态。
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
import { PAGE_SIZE } from '../src/components/QualityPanel/RequestDetails';
import { MAX_SERIES } from '../src/components/QualityPanel/Trend';

configure({ asyncUtilTimeout: 10_000 });

const NOW = new Date(2026, 9, 24, 15, 0, 0).getTime();

const dist = (n: number, p50: number) => ({ n, mean: p50, p50, p90: p50 * 2, p99: p50 * 3 });

function stats(key: string, over: Partial<QualityStats> = {}): QualityStats {
  return {
    key,
    label: key,
    requests: 100,
    attempts: 110,
    ok: 90,
    failed: 6,
    cancelled: 4,
    cancelBeforeFirst: 1,
    cancelDuring: 3,
    streamBreak: 2,
    fallback: 5,
    burst: 0,
    successRate: 0.9375,
    failureRate: 0.0625,
    cancelRate: 0.04,
    streamBreakRate: 0.02,
    fallbackRate: 0.05,
    cacheHitTokenRate: 0.42,
    cacheHitRequestRate: 0.6,
    failures: { 'stream-break': 2, 'rate-limit': 3, auth: 1 },
    ttfb: dist(100, 400),
    ttft: dist(100, 1200),
    ttftText: dist(100, 1500),
    tpot: dist(100, 30),
    e2e: dist(100, 6000),
    outputTps: dist(100, 45),
    tokens: { input: 50_000, output: 8_000, cacheRead: 21_000, cacheWrite: 0, reasoning: 0 },
    cost: 1.2,
    ...over,
  };
}

function record(i: number, over: Partial<QualityRecord> = {}): QualityRecord {
  return {
    id: `r${i}`,
    layer: 'gateway',
    ts: NOW - i * 60_000,
    client: 'claude',
    source: 'thirdParty',
    provider: 'zp',
    keyId: 'k1',
    model: 'zp/glm-5',
    ingress: 'messages',
    wire: 'chat',
    resolved: 'binding',
    stream: true,
    outcome: 'ok',
    status: 200,
    timing: { headersMs: 300, firstContentMs: 900, lastContentMs: 4000, endMs: 4100 },
    tokens: { input: 1000, output: 200, cacheRead: 600 },
    tabId: 'tab-7f3a91c2d4',
    generation: 2,
    traceId: 'abc123def456',
    ...over,
  };
}

let calls: Array<[string, unknown]> = [];
let gatewayEmpty = false;
let cliHasData = true;
let total = 120;
let seriesCount = 2;

function install() {
  calls = [];
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: vi.fn(async (ch: string, arg?: unknown) => {
      calls.push([ch, arg]);
      switch (ch) {
        case 'ai:quality:query': {
          const q = arg as QualityQuery;
          const empty = (q.layer ?? 'gateway') === 'gateway' ? gatewayEmpty : !cliHasData;
          if (empty) return { total: stats('*', { requests: 0 }), groups: [], minSamples: 20 };
          const groups =
            q.groupBy === 'modelFamily'
              ? [stats('glm-5'), stats('deepseek-v4')]
              : [
                  stats('zp', { label: '智谱' }),
                  stats('ds', { label: 'DeepSeek', successRate: 0.99, burst: 3 }),
                  stats('amux', { label: 'Amux', ttft: dist(10, 900) }),
                  stats('or', { label: 'OpenRouter' }),
                  stats('sf', { label: 'SiliconFlow' }),
                ];
          return {
            total: stats('*'),
            groups,
            minSamples: 20,
            ...(q.withPrevious ? { previous: stats('*', { successRate: 0.9, requests: 80 }) } : {}),
          };
        }
        case 'ai:quality:series': {
          const q = arg as QualitySeriesQuery;
          const buckets = [0, 1, 2].map((i) => NOW - (2 - i) * 86_400_000);
          return {
            buckets,
            series: Array.from({ length: q.groupBy ? seriesCount : 1 }, (_, i) => ({
              key: `s${i}`,
              label: `Series ${i}`,
              values: [0.9, null, 0.95],
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
                        provider: 'zp',
                        keyId: 'k1',
                        model: 'zp/glm-5',
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
          return { ok: true, path: '/tmp/quality.csv' };
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
  seriesCount = 2;
  install();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

const last = <T,>(ch: string): T => calls.filter((c) => c[0] === ch).at(-1)![1] as T;

const Harness: React.FC<{ start?: QualityTab }> = ({ start = 'overview' }) => {
  const [tab, setTab] = useState<QualityTab>(start);
  return <QualityPanel tab={tab} onTab={setTab} now={() => NOW} />;
};

describe('QualityPanel 总览', () => {
  it('指标卡（与上一周期比）、失败原因、按供应商的表；分区与口径有可读的名字', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-overview');
    expect(r.getByRole('tablist', { name: '模型质量分区' })).toBeTruthy();
    expect(r.getByRole('tablist', { name: '测量口径' })).toBeTruthy();
    expect(r.getByTestId('quality-tile-successRate').textContent).toContain('94%');
    expect(r.getByTestId('quality-tile-ttft.p50').textContent).toContain('1.2 s');
    expect(r.getByTestId('quality-tile-outputTps.p50').textContent).toContain('45 tok/s');
    // 成功率比上一周期高约 3.75 个百分点：显示升降而不是只靠颜色
    expect(
      within(r.getByTestId('quality-tile-successRate')).getByTestId('quality-delta').textContent,
    ).toMatch(/\+3\.[78] pp（变好）/);
    const q = last<QualityQuery>('ai:quality:query');
    expect(q).toMatchObject({ layer: 'gateway', groupBy: 'provider', withPrevious: true });
    // 失败原因按次数排序
    const rows = r.getAllByTestId('quality-failure-row');
    expect(rows[0]!.textContent).toContain('限流');
    expect(r.getAllByTestId('quality-provider-row')).toHaveLength(5);
  });

  it('点失败原因 / 供应商钻取到请求明细，并带上筛选', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-overview');
    fireEvent.click(r.getAllByTestId('quality-failure-row')[0]!);
    await r.findByTestId('quality-requests');
    await waitFor(() =>
      expect(last<QualityRequestsQuery>('ai:quality:requests').filters).toEqual({
        outcome: ['rate-limit'],
      }),
    );
    expect(r.getByTestId('quality-drill-chips').textContent).toContain('限流');
    // 移除筛选
    fireEvent.click(r.getByTestId('quality-drill-remove-outcome'));
    await waitFor(() =>
      expect(last<QualityRequestsQuery>('ai:quality:requests').filters).toBeUndefined(),
    );
  });

  it('客户端筛选与口径切换会重新查询', async () => {
    const r = render(<Harness />);
    await r.findByTestId('quality-overview');
    fireEvent.change(r.getByTestId('quality-client'), { target: { value: 'codex' } });
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').filters).toEqual({ client: ['codex'] }),
    );
    fireEvent.click(r.getByRole('tab', { name: 'CLI 层' }));
    await waitFor(() => expect(last<QualityQuery>('ai:quality:query').layer).toBe('cli'));
    expect(r.getByTestId('quality-layer-note').textContent).toContain('CLI 层');
  });

  it('网关层没数据、CLI 层有（只用了官方账号）：提示切到 CLI 层', async () => {
    gatewayEmpty = true;
    const r = render(<Harness />);
    fireEvent.click(await r.findByTestId('quality-switch-cli'));
    await waitFor(() => expect(last<QualityQuery>('ai:quality:query').layer).toBe('cli'));
    await r.findByTestId('quality-overview');
  });

  it('两层都没数据：普通空状态', async () => {
    gatewayEmpty = true;
    cliHasData = false;
    const r = render(<Harness />);
    await r.findByText('这段时间还没有质量数据');
    expect(r.queryByTestId('quality-empty-official')).toBeNull();
  });

  it('不在桌面环境：显示占位而不是报错', () => {
    delete (window as unknown as { aiIPC?: unknown }).aiIPC;
    const r = render(<Harness />);
    expect(r.getByText('模型质量仅在桌面应用中提供')).toBeTruthy();
  });
});

describe('QualityPanel 对比', () => {
  it('按维度分组、可排序；勾选 2～4 项并排对比，第 5 项不能再勾', async () => {
    const r = render(<Harness start="compare" />);
    await r.findByTestId('quality-compare-table');
    expect(r.getAllByTestId('quality-compare-row')).toHaveLength(5);
    // 整段吐出的提示
    expect(r.getByText('整段吐出 3')).toBeTruthy();
    // 样本少（n=10）：p50 照常显示，p90 / p99 不显示
    fireEvent.click(r.getByTestId('quality-columns-toggle'));
    fireEvent.click(r.getByTestId('quality-column-ttft.p90'));
    const amux = r
      .getAllByTestId('quality-compare-row')
      .find((x) => x.textContent!.includes('Amux'))!;
    expect(amux.textContent).toContain('900 ms');
    expect(within(amux).getAllByText('—').length).toBeGreaterThan(0);

    // 排序：点「成功率」按从高到低
    fireEvent.click(r.getByTestId('quality-sort-successRate'));
    expect(r.getAllByTestId('quality-compare-row')[0]!.textContent).toContain('DeepSeek');

    const boxes = r.getAllByTestId('quality-compare-select') as HTMLInputElement[];
    fireEvent.click(boxes[0]!);
    expect(r.queryByTestId('quality-side-by-side')).toBeNull();
    fireEvent.click(boxes[1]!);
    expect(r.getByTestId('quality-side-by-side')).toBeTruthy();
    fireEvent.click(boxes[2]!);
    fireEvent.click(boxes[3]!);
    expect(boxes[4]!.disabled).toBe(true);
    expect(boxes[0]!.getAttribute('aria-label')).toContain('加入并排对比');
  });

  it('开关、计数口径与分组写进查询', async () => {
    const r = render(<Harness start="compare" />);
    await r.findByTestId('quality-compare-table');
    fireEvent.click(r.getByTestId('quality-cancel-in'));
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').cancelInDenominator).toBe(true),
    );
    fireEvent.click(r.getByTestId('quality-rejected-in'));
    await waitFor(() => expect(last<QualityQuery>('ai:quality:query').includeRejected).toBe(true));
    fireEvent.click(r.getByRole('tab', { name: '按尝试' }));
    await waitFor(() => expect(last<QualityQuery>('ai:quality:query').countBy).toBe('attempt'));
    fireEvent.change(r.getByTestId('quality-groupby'), { target: { value: 'model' } });
    await waitFor(() => expect(last<QualityQuery>('ai:quality:query').groupBy).toBe('model'));
    // CLI 层没有「按尝试」，也没有 Key 维度
    fireEvent.click(r.getByRole('tab', { name: 'CLI 层' }));
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query')).toMatchObject({
        layer: 'cli',
        countBy: 'request',
      }),
    );
    expect(r.queryByRole('tab', { name: '按尝试' })).toBeNull();
  });

  it('快捷对比：同一模型跨供应商（按供应商分组、筛选模型族）；本周 vs 上周', async () => {
    const r = render(<Harness start="compare" />);
    await r.findByTestId('quality-compare-table');
    fireEvent.click(r.getByTestId('quality-preset-family'));
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query')).toMatchObject({
        groupBy: 'provider',
        filters: { modelFamily: ['glm-5'] },
      }),
    );
    fireEvent.change(r.getByTestId('quality-preset-value'), { target: { value: 'deepseek-v4' } });
    await waitFor(() =>
      expect(last<QualityQuery>('ai:quality:query').filters).toEqual({
        modelFamily: ['deepseek-v4'],
      }),
    );
    fireEvent.click(r.getByTestId('quality-preset-period'));
    await r.findByTestId('quality-period');
    expect(last<QualityQuery>('ai:quality:query').withPrevious).toBe(true);
  });

  it('点格子钻取到请求明细；导出对比表 CSV', async () => {
    const r = render(<Harness start="compare" />);
    await r.findByTestId('quality-compare-table');
    fireEvent.click(r.getByTestId('quality-export-table'));
    await waitFor(() =>
      expect(last<{ kind: string }>('ai:quality:export')).toMatchObject({ kind: 'table' }),
    );
    fireEvent.click(r.getByRole('button', { name: '智谱' }));
    await r.findByTestId('quality-requests');
    await waitFor(() =>
      expect(last<QualityRequestsQuery>('ai:quality:requests').filters).toEqual({
        provider: ['zp'],
      }),
    );
  });
});

describe('QualityPanel 趋势', () => {
  it('多条折线带图例与线尾标注；超过 4 条只画前 4 条；可切表格视图', async () => {
    seriesCount = 6;
    const r = render(<Harness start="trend" />);
    await r.findByTestId('quality-line-chart');
    expect(r.getByRole('img', { name: '成功率趋势' })).toBeTruthy();
    expect(r.getByLabelText('图例').querySelectorAll('li')).toHaveLength(MAX_SERIES);
    expect(r.getByTestId('quality-series-capped')).toBeTruthy();
    const q = last<QualitySeriesQuery>('ai:quality:series');
    expect(q).toMatchObject({ metric: 'successRate', groupBy: 'provider', bucket: 'day' });
    fireEvent.change(r.getByTestId('quality-trend-metric'), { target: { value: 'ttft.p50' } });
    await waitFor(() =>
      expect(last<QualitySeriesQuery>('ai:quality:series').metric).toBe('ttft.p50'),
    );
    fireEvent.click(r.getByRole('tab', { name: '表格' }));
    const table = await r.findByTestId('quality-series-table');
    // 表格里是全部 6 项
    expect(table.querySelectorAll('thead th')).toHaveLength(7);
  });

  it('悬停显示该时段各条线的数值', async () => {
    const r = render(<Harness start="trend" />);
    await r.findByTestId('quality-line-chart');
    fireEvent.mouseEnter(r.getAllByTestId('quality-chart-hit')[2]!);
    expect(r.getByText(/Series 0 95%/)).toBeTruthy();
  });
});

describe('QualityPanel 请求明细', () => {
  it('逐条显示结果、时间线、标签、解析方式与追踪 id；回退的展开各次尝试', async () => {
    const r = render(<Harness start="requests" />);
    await r.findByTestId('quality-requests');
    const rows = await r.findAllByTestId('quality-request');
    expect(rows).toHaveLength(PAGE_SIZE);
    const first = rows[0]!;
    expect(within(first).getByTestId('quality-request-outcome').textContent).toContain('断流');
    expect(within(first).getByTestId('quality-timeline').getAttribute('aria-label')).toContain(
      '首字节',
    );
    expect(within(first).getByTestId('quality-request-tab').textContent).toBe('标签 tab-7f3a');
    expect(within(first).getByTestId('quality-request-resolved').textContent).toBe('标签选的模型');
    expect(within(first).getByTestId('quality-request-trace').textContent).toContain(
      'abc123def456',
    );
    fireEvent.click(within(first).getByTestId('quality-request-attempts-toggle'));
    const attempts = within(first).getByTestId('quality-request-attempts');
    expect(attempts.querySelectorAll('li')).toHaveLength(2);
    expect(attempts.textContent).toContain('限流');
  });

  it('分页、按结果筛选、导出 CSV', async () => {
    const r = render(<Harness start="requests" />);
    await r.findAllByTestId('quality-request');
    expect(r.getByTestId('quality-page').textContent).toBe('第 1 / 3 页');
    fireEvent.click(r.getByTestId('quality-page-next'));
    await waitFor(() =>
      expect(last<QualityRequestsQuery>('ai:quality:requests').offset).toBe(PAGE_SIZE),
    );
    // 换筛选回到第一页
    fireEvent.change(r.getByTestId('quality-filter-outcome'), {
      target: { value: 'stream-break' },
    });
    await waitFor(() =>
      expect(last<QualityRequestsQuery>('ai:quality:requests')).toMatchObject({
        offset: 0,
        filters: { outcome: ['stream-break'] },
      }),
    );
    fireEvent.click(r.getByTestId('quality-export-requests'));
    await waitFor(() =>
      expect(last<{ kind: string }>('ai:quality:export')).toMatchObject({ kind: 'requests' }),
    );
    expect((await r.findByTestId('quality-export-msg')).textContent).toContain('/tmp/quality.csv');
  });

  it('没有请求：空状态；保留时长写入设置', async () => {
    total = 0;
    const r = render(<Harness start="requests" />);
    await r.findByText('这段时间还没有请求');
    await waitFor(() =>
      expect((r.getByTestId('quality-retention-days') as HTMLSelectElement).value).toBe('30'),
    );
    fireEvent.change(r.getByTestId('quality-retention-days'), { target: { value: '90' } });
    await waitFor(() =>
      expect(last<{ retentionDays: number }>('ai:quality:settings-set')).toEqual({
        retentionDays: 90,
      }),
    );
  });
});
