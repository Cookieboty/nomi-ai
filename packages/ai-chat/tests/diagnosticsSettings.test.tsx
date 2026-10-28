// @vitest-environment happy-dom
/**
 * 设置 → 隐私与权限 → 诊断日志（docs/design/cli-plugin-architecture.md §8.1）。
 */
import { cleanup, configure, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiagnosticsSettings } from '../src/components/SettingsView/DiagnosticsSettings';

// D2 的过程经契约替身转发到下面的旧桥假实现（见 helpers/shellApi）
vi.mock('../src/services/api', () => import('./helpers/shellApi'));

configure({ asyncUtilTimeout: 10_000 });

const base = { enabled: false, forced: false, saveLogs: false, dir: '/u/logs', bodyTrace: false };

function mount(
  view: typeof base,
  exportResult: unknown = { ok: true, path: '/d/n.zip', files: [] },
) {
  let cur = { ...view };
  const api = {
    get: vi.fn(async () => cur),
    set: vi.fn(async (on: boolean) => {
      cur = { ...cur, saveLogs: on, enabled: cur.forced || on, bodyTrace: cur.forced || on };
      return cur;
    }),
    openFolder: vi.fn(async () => true),
    export: vi.fn(async () => exportResult),
  };
  (window as unknown as { electronAPI?: unknown }).electronAPI = { diagnostics: api };
  return { api, r: render(<DiagnosticsSettings />) };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('DiagnosticsSettings', () => {
  it('正式版：默认关，打开走 IPC', async () => {
    const { api, r } = mount(base);
    const sw = await r.findByTestId('diagnostics-switch');
    await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(api.set).toHaveBeenCalledWith(true);
  });

  it('开发版：显示为开且不可关，注明「开发版始终记录」', async () => {
    const { r } = mount({ ...base, enabled: true, forced: true, bodyTrace: true });
    const sw = await r.findByTestId('diagnostics-switch');
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(sw.hasAttribute('disabled')).toBe(true);
    expect(r.getByText('开发版始终记录')).toBeTruthy();
  });

  it('打开日志文件夹、导出诊断包（提示包含对话内容）', async () => {
    const { api, r } = mount(base);
    await r.findByTestId('diagnostics-switch');
    expect(r.getByText(/诊断包包含对话内容/)).toBeTruthy();
    fireEvent.click(r.getByTestId('diagnostics-open-folder'));
    await waitFor(() => expect(api.openFolder).toHaveBeenCalled());
    fireEvent.click(r.getByTestId('diagnostics-export'));
    const msg = await r.findByTestId('diagnostics-message');
    expect(msg.textContent).toContain('/d/n.zip');
  });

  it('导出失败显示原因；取消不提示', async () => {
    const { r } = mount(base, { ok: false, error: 'EACCES' });
    await r.findByTestId('diagnostics-switch');
    fireEvent.click(r.getByTestId('diagnostics-export'));
    expect((await r.findByTestId('diagnostics-message')).textContent).toContain('EACCES');
  });

  it('没有桥（浏览器预览）：不渲染', () => {
    const r = render(<DiagnosticsSettings />);
    expect(r.queryByTestId('settings-diagnostics')).toBeNull();
  });
});
