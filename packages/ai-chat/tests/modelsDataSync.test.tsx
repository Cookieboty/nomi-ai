// @vitest-environment happy-dom
/**
 * 「模型」页顶部的模型数据同步：显示目录来源与上次核对时间，立即同步，启动时自动同步开关。
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelsDataSyncCard } from '../src/components/ModelsPage/ModelsDataSyncCard';
import type { GatewayState } from '../src/services/gatewayClient';

const usageState = (over: { auto?: boolean; checkedAt?: number } = {}) => ({
  settings: { modelsSyncAuto: over.auto ?? true },
  pricing: {
    date: '2026-10-01',
    builtin: [],
    sync: { count: 300, fetchedAt: 1, checkedAt: over.checkedAt ?? 0, tableDate: '2026-10-25' },
  },
});

const gateway = (synced: boolean) =>
  ({
    catalog: { models: 318, version: synced ? '2026-10-26' : '2026-10-25', synced },
  }) as unknown as GatewayState;

afterEach(cleanup);

describe('模型数据同步卡片', () => {
  it('显示目录来源；立即同步后提示结果', async () => {
    const invoke = vi.fn(async (ch: string) => {
      if (ch === 'ai:usage:state') return usageState();
      if (ch === 'ai:usage:price-sync')
        return {
          ...usageState({ checkedAt: Date.now() }),
          result: { ok: true, status: 'updated', count: 300, skipped: 0 },
        };
      return undefined;
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelsDataSyncCard gateway={gateway(false)} />);
    expect((await r.findByTestId('models-data-status')).textContent).toContain(
      '使用内置模型目录（2026-10-25）· 收录 318 个模型',
    );
    fireEvent.click(r.getByTestId('models-data-sync-now'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:usage:price-sync'));
    expect((await r.findByTestId('models-data-result')).textContent).toBe(
      '已同步最新的模型参数与价格',
    );
    expect(r.getByTestId('models-data-status').textContent).toContain('上次核对');
    r.rerender(<ModelsDataSyncCard gateway={gateway(true)} />);
    expect(r.getByTestId('models-data-status').textContent).toContain(
      '已同步 models.dev（2026-10-26）',
    );
  });

  it('失败时说明原因，并继续用现有数据', async () => {
    const invoke = vi.fn(async (ch: string) => {
      if (ch === 'ai:usage:state') return usageState();
      if (ch === 'ai:usage:price-sync')
        return { ...usageState(), result: { ok: false, reason: 'network' } };
      return undefined;
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelsDataSyncCard gateway={gateway(false)} />);
    fireEvent.click(await r.findByTestId('models-data-sync-now'));
    expect((await r.findByTestId('models-data-result')).textContent).toContain('继续使用现有数据');
  });

  it('启动时自动同步开关', async () => {
    const invoke = vi.fn(async (ch: string, ...a: unknown[]) => {
      if (ch === 'ai:usage:state') return usageState();
      if (ch === 'ai:usage:set-settings')
        return { modelsSyncAuto: (a[0] as { modelsSyncAuto: boolean }).modelsSyncAuto };
      return undefined;
    });
    (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
    const r = render(<ModelsDataSyncCard gateway={gateway(false)} />);
    const sw = await r.findByTestId('models-data-auto');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ai:usage:set-settings', { modelsSyncAuto: false }),
    );
  });
});
