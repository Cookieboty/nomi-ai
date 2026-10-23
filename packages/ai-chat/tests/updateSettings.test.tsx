// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  UpdateSettings,
  statusLabel,
  type UpdateState,
} from '../src/components/SettingsView/UpdateSettings';

const base: UpdateState = { status: 'idle', currentVersion: '1.1.1', autoCheck: true };

const mount = (state: UpdateState, next: UpdateState) => {
  const check = vi.fn(async () => next);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    updates: {
      get: async () => state,
      check,
      download: async () => state,
      install: async () => state,
      setAutoCheck: async () => state,
      onChanged: () => () => undefined,
    },
  };
  return { r: render(<UpdateSettings />), check };
};

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('自动更新失败后能重试', () => {
  it('按失败的阶段说明：检查 / 下载 / 安装', () => {
    const err = (errorStage: UpdateState['errorStage']) =>
      statusLabel({ ...base, status: 'error', error: 'x', errorStage });
    expect(err('check')).toBe('检查更新失败：x');
    expect(err('download')).toBe('下载更新失败：x');
    expect(err('install')).toBe('安装更新失败：x');
    // 老版本主进程没有 errorStage
    expect(err(undefined)).toBe('检查更新失败：x');
  });

  it('失败时按钮是「重试」且可点，点了重新检查；下载中不可点', async () => {
    const failed: UpdateState = {
      ...base,
      status: 'error',
      error: 'download stalled: no progress for 90s',
      errorStage: 'download',
      availableVersion: '1.2.0',
    };
    const { check } = mount(failed, { ...base, status: 'downloading', percent: 5 });
    const btn = await screen.findByTestId('updates-check');
    await waitFor(() => expect(btn.textContent).toBe('重试'));
    expect(screen.getByTestId('updates-status').textContent).toContain('下载更新失败');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    expect(btn.textContent).toBe('检查更新');
  });
});
