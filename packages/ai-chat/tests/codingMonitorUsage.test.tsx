// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodingMonitor } from '../src/components/CodingMonitor';

const session = (over: Record<string, unknown>) => ({
  id: 'x',
  kind: 'claude',
  label: 'Claude Code',
  project: 'app',
  title: 'Refactor',
  status: 'running',
  path: '',
  mtime: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

const install = (currency: 'USD' | 'CNY') => {
  const agents = {
    settings: {
      enabled: true,
      osNotify: false,
      summaryEnabled: true,
      cooldownMs: 1000,
      tools: { claude: true, codex: true, dsh: true },
    },
    detected: ['claude'],
    lastRemindAt: 0,
    sessions: [
      session({
        id: 'claude:a',
        usage: { tokens: 1200, costUsd: 0.5, calls: 3, unpriced: false },
      }),
      session({
        id: 'dsh:b',
        kind: 'dsh',
        label: 'dsh',
        title: 'Other',
        usage: { tokens: 900, costUsd: null, calls: 1, unpriced: true },
      }),
      session({ id: 'codex:c', kind: 'codex', label: 'Codex', title: 'No usage' }),
    ],
  };
  (window as unknown as { aiIPC: unknown }).aiIPC = {
    invoke: vi.fn(async (ch: string) => {
      if (ch === 'ai:agents:state') return agents;
      if (ch === 'ai:usage:state')
        return {
          settings: { currency, cnyPerUsd: 7 },
          detected: [],
          records: 1,
          lastScanAt: 0,
          pricing: { date: '', builtin: [] },
        };
      return null;
    }),
    on: vi.fn(() => () => undefined),
  };
};

afterEach(() => {
  cleanup();
  delete (window as unknown as { aiIPC?: unknown }).aiIPC;
});

describe('CodingMonitor：会话累计 Token / 费用', () => {
  it('有用量的会话显示累计 Token 与费用；未定价不编造；没有用量的不显示', async () => {
    install('USD');
    const { findAllByTestId } = render(<CodingMonitor />);
    await findAllByTestId('agents-session-meta');
    await waitFor(async () => {
      const metas = (await findAllByTestId('agents-session-meta')).map((m) => m.textContent ?? '');
      expect(metas.some((m) => m.includes('累计 1.2K Token · $0.500'))).toBe(true);
      expect(metas.some((m) => m.includes('累计 900 Token · 未定价'))).toBe(true);
      expect(metas.filter((m) => m.includes('累计'))).toHaveLength(2);
    });
  });

  it('跟随币种设置换算', async () => {
    install('CNY');
    const { findAllByTestId } = render(<CodingMonitor />);
    await waitFor(async () => {
      const metas = (await findAllByTestId('agents-session-meta')).map((m) => m.textContent ?? '');
      expect(metas.some((m) => m.includes('累计 1.2K Token · ¥3.50'))).toBe(true);
    });
  });
});
