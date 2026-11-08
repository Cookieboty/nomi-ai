// @vitest-environment happy-dom
/**
 * 设置 → 调试（开发版）：灵动岛样例按钮把样例发给内核（island.debug）
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebugSection } from '../src/components/SettingsView/DebugSection';
import { SETTINGS_SECTIONS } from '../src/components/SettingsView/sections';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('设置 → 调试', () => {
  it('测试与打包版里没有调试分区', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.id === 'debug')).toBe(false);
  });

  it('通知、等你处理的样例与清掉都发给 island.debug', async () => {
    const calls: unknown[] = [];
    installFakeApi(async (ch: string, input?: unknown) => {
      if (ch === 'island.debug') calls.push(input);
      return true;
    });
    const view = render(<DebugSection />);
    fireEvent.click(view.getByTestId('debug-island-notice-failed'));
    fireEvent.click(view.getByTestId('debug-island-pending-many'));
    fireEvent.click(view.getByTestId('debug-island-clear'));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[0]).toMatchObject({ op: 'notice', notice: { kind: 'agent', status: 'failed' } });
    const many = calls[1] as { op: string; items: { id: string; actions: unknown[] }[] };
    expect(many.op).toBe('pending');
    expect(many.items).toHaveLength(7);
    expect(many.items.every((i) => i.actions.length > 0)).toBe(true);
    expect(calls[2]).toEqual({ op: 'clear' });
  });
});
