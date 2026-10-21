// @vitest-environment happy-dom
/**
 * 用量面板「最近请求」（统一网关请求日志，unified-gateway §4.5 / §14）。
 */
import { cleanup, configure, fireEvent, render, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatHitRate,
  formatMs,
  GatewayRequests,
  wireLabel,
} from '../src/components/UsagePanel/GatewayRequests';

configure({ asyncUtilTimeout: 10_000 });

const NOW = Date.now();

const VIEW = {
  requests: [
    {
      id: '2',
      ts: NOW,
      client: 'claude',
      ingress: 'messages',
      wire: 'chat',
      providerId: 'zp',
      provider: '智谱',
      keyId: 'k2',
      key: '备用 Key',
      model: 'zp/glm-5',
      status: 200,
      ms: 2400,
      firstByteMs: 600,
      attempts: 2,
      input: 400,
      output: 100,
      cacheRead: 600,
      cacheWrite: 0,
      notes: ['省略了图片'],
    },
    {
      id: '1',
      ts: NOW - 1000,
      client: 'codex',
      ingress: 'responses',
      status: 502,
      ms: 120,
      attempts: 1,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      error: 'Nomi 网关：所有候选都失败了',
    },
  ],
  summary: {
    requests: 2,
    failed: 1,
    fallbacks: 1,
    input: 400,
    output: 100,
    cacheRead: 600,
    cacheWrite: 0,
    cacheHitRate: 0.6,
    avgMs: 1260,
    avgFirstByteMs: 600,
  },
  byProvider: [
    {
      key: 'zp',
      label: '智谱',
      requests: 1,
      failed: 0,
      fallbacks: 1,
      input: 400,
      output: 100,
      cacheRead: 600,
      cacheWrite: 0,
      tokens: 1100,
      cacheHitRate: 0.6,
      avgMs: 2400,
    },
  ],
  byKey: [
    {
      key: 'zp/k2',
      label: '智谱 · 备用 Key',
      requests: 1,
      failed: 0,
      fallbacks: 1,
      input: 400,
      output: 100,
      cacheRead: 600,
      cacheWrite: 0,
      tokens: 1100,
      cacheHitRate: 0.6,
      avgMs: 2400,
    },
  ],
  trace: { enabled: false, dir: '/tmp/nomi/gateway/trace' },
};

let calls: Array<[string, ...unknown[]]>;
let view: typeof VIEW;

beforeEach(() => {
  calls = [];
  view = JSON.parse(JSON.stringify(VIEW));
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: vi.fn(async (ch: string, ...a: unknown[]) => {
      calls.push([ch, ...a]);
      switch (ch) {
        case 'ai:usage:gateway-requests':
          return view;
        case 'ai:usage:gateway-trace-set':
          view.trace = { ...view.trace, enabled: a[0] === true };
          return view.trace;
        case 'ai:usage:gateway-clear':
          view = { ...view, requests: [] };
          return view;
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

describe('helpers', () => {
  it('formats durations, hit rates and protocols', () => {
    expect(formatMs(850)).toBe('850 ms');
    expect(formatMs(2400)).toBe('2.4 s');
    expect(formatHitRate(null)).toBe('—');
    expect(formatHitRate(0.6)).toBe('60%');
    expect(wireLabel('responses')).toBe('Responses');
    expect(wireLabel(undefined)).toBe('—');
  });
});

describe('GatewayRequests', () => {
  it('lists recent requests with protocols, provider / key, fallback badge and notes', async () => {
    const r = render(<GatewayRequests />);
    const rows = await r.findAllByTestId('gateway-request');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!);
    expect(first.getByText('Messages → Chat')).toBeTruthy();
    expect(first.getByText('智谱 / 备用 Key')).toBeTruthy();
    expect(first.getByText('zp/glm-5')).toBeTruthy();
    expect(first.getByTestId('gateway-request-fallback')).toBeTruthy();
    expect(first.getByTestId('gateway-request-status').textContent).toBe('200');
    expect(first.getByTestId('gateway-request-note').textContent).toBe('省略了图片');
    expect(first.getByText('2.4 s')).toBeTruthy();
    const second = within(rows[1]!);
    expect(second.queryByTestId('gateway-request-fallback')).toBeNull();
    expect(second.getByTestId('gateway-request-status').textContent).toBe('502');
    expect(second.getByText('Nomi 网关：所有候选都失败了')).toBeTruthy();
    expect(second.getByText('Responses → —')).toBeTruthy();
  });

  it('shows the cache hit rate and switches between provider and key dimensions', async () => {
    const r = render(<GatewayRequests />);
    const card = await r.findByTestId('gateway-card-cache');
    expect(card.textContent).toContain('60%');
    expect(within(r.getByTestId('gateway-breakdown-provider')).getByText('智谱')).toBeTruthy();
    fireEvent.click(r.getByRole('tab', { name: '按 Key' }));
    const byKey = await r.findByTestId('gateway-breakdown-key');
    expect(within(byKey).getByText('智谱 · 备用 Key')).toBeTruthy();
  });

  it('toggles debug trace through IPC', async () => {
    const r = render(<GatewayRequests />);
    const sw = await r.findByTestId('gateway-trace-switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(calls.some(([ch, v]) => ch === 'ai:usage:gateway-trace-set' && v === true)).toBe(true);
    expect(r.getByText(/\/tmp\/nomi\/gateway\/trace/)).toBeTruthy();
  });

  it('clears the log and shows the empty state', async () => {
    const r = render(<GatewayRequests />);
    await r.findAllByTestId('gateway-request');
    fireEvent.click(r.getByTestId('gateway-requests-clear'));
    await waitFor(() => expect(r.queryAllByTestId('gateway-request')).toHaveLength(0));
    expect(r.getByText('还没有经过网关的请求')).toBeTruthy();
  });
});
