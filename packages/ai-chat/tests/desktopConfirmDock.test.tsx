// @vitest-environment happy-dom
/**
 * Nomi 桌面工具的授权卡片（对话窗口）：挂载时补拉待答复的请求、跟着确认 / 取消事件增减；
 * 工具确认可允许 / 拒绝 / 本次不再询问，必须看过详情的默认展开详情、出现 1 秒后才能确认；
 * 请求文件夹可授权建议的文件夹 / 另选 / 拒绝，建议不能直接授权时只给另选。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopConfirmDock } from '../src/components/DesktopConfirmDock';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const req = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  tool: 'fs_write_text',
  danger: 'write',
  summary: '写入 a.txt？',
  argsJson: '{"path":"a.txt"}',
  dialog: false,
  rememberable: true,
  reason: 'first-use',
  expiresAt: Date.now() + 60_000,
  ...over,
});

let fake: FakeApi;
let pending: unknown[] = [];

beforeEach(() => {
  pending = [];
  fake = installFakeApi({
    'desktop.state': () => ({ scopes: [], policies: {}, localOnly: false, pending }),
    'desktop.confirmAnswer': () => undefined,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetFakeApi();
});

async function mount() {
  render(<DesktopConfirmDock />);
  await act(() => fake.settle());
}

describe('DesktopConfirmDock', () => {
  it('pulls pending requests on mount, and follows request / cancel events', async () => {
    pending = [req()];
    await mount();
    expect(screen.getByTestId('desktop-confirm-card')).toBeTruthy();
    await act(() => fake.emit('desktop.confirmRequest', req({ id: 'c2', summary: '另一个' })));
    expect(screen.getAllByTestId('desktop-confirm-card')).toHaveLength(2);
    await act(() => fake.emit('desktop.confirmCancel', 'c1'));
    await act(() => fake.emit('desktop.confirmCancel', 'c2'));
    expect(screen.queryByTestId('desktop-confirm-dock')).toBeNull();
  });

  it('allow with "don\'t ask again" answers through the contract', async () => {
    pending = [req()];
    await mount();
    fireEvent.click(screen.getByTestId('desktop-confirm-remember'));
    fireEvent.click(screen.getByTestId('desktop-confirm-allow'));
    await act(() => fake.settle());
    expect(fake.inputs('desktop.confirmAnswer')).toEqual([
      { id: 'c1', allow: true, remember: true, pick: false },
    ]);
  });

  it('must-review (destructive / first cloud send): details open by default, confirm armed after a second', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pending = [req({ danger: 'destructive', dialog: true, rememberable: false })];
    await mount();
    expect(screen.getByTestId('desktop-confirm-detail').textContent).toContain('fs_write_text');
    expect((screen.getByTestId('desktop-confirm-allow') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect((screen.getByTestId('desktop-confirm-allow') as HTMLButtonElement).disabled).toBe(false);
  });

  it('folder request: grant the checked folder, or pick another', async () => {
    pending = [
      req({
        id: 's1',
        kind: 'scope',
        tool: 'desktop_request_scope',
        danger: 'read',
        scopePath: '/Users/me/proj',
        scopeMode: 'read-write',
        preview: 'need the repo',
      }),
    ];
    await mount();
    expect(screen.getByTestId('desktop-scope-path').textContent).toBe('/Users/me/proj');
    expect(screen.getByText('need the repo')).toBeTruthy();
    fireEvent.click(screen.getByTestId('desktop-scope-grant'));
    await act(() => fake.settle());
    expect(fake.inputs('desktop.confirmAnswer')).toEqual([
      { id: 's1', allow: true, remember: false, pick: false },
    ]);
  });

  it('folder request without a grantable suggestion only offers choosing one', async () => {
    pending = [req({ id: 's2', kind: 'scope', tool: 'desktop_request_scope', danger: 'read' })];
    await mount();
    expect(screen.queryByTestId('desktop-scope-grant')).toBeNull();
    fireEvent.click(screen.getByTestId('desktop-scope-pick'));
    await act(() => fake.settle());
    expect(fake.inputs('desktop.confirmAnswer')).toEqual([
      { id: 's2', allow: false, remember: false, pick: true },
    ]);
  });
});
