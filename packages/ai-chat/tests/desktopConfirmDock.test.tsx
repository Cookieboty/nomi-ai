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

  it('「始终允许」在「拒绝」前面，点了 = 允许并记住；「允许」只放行这一次', async () => {
    pending = [req(), req({ id: 'c2' })];
    await mount();
    const [first, second] = screen.getAllByTestId('desktop-confirm-card');
    const buttons = [...first!.querySelectorAll('button')].map((b) => b.dataset.testid);
    expect(buttons.indexOf('desktop-confirm-always')).toBe(
      buttons.indexOf('desktop-confirm-deny') - 1,
    );
    fireEvent.click(first!.querySelector('[data-testid="desktop-confirm-always"]')!);
    fireEvent.click(second!.querySelector('[data-testid="desktop-confirm-allow"]')!);
    await act(() => fake.settle());
    expect(fake.inputs('desktop.confirmAnswer')).toEqual([
      { id: 'c1', allow: true, remember: true, pick: false },
      { id: 'c2', allow: true, remember: false, pick: false },
    ]);
  });

  it('跑命令的确认：「本会话始终执行」只对这条命令、经契约带 session 答复', async () => {
    pending = [req({ tool: 'workspace_run', danger: 'destructive', sessionCommand: 'pbpaste' })];
    await mount();
    const btn = screen.getByTestId('desktop-confirm-session');
    expect(btn.getAttribute('title')).toContain('pbpaste');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(() => vi.advanceTimersByTimeAsync(1100));
    fireEvent.click(btn);
    await act(() => fake.settle());
    expect(fake.inputs('desktop.confirmAnswer')).toEqual([
      { id: 'c1', allow: true, remember: false, pick: false, session: true },
    ]);
  });

  it('没有 sessionCommand 时不显示「本会话始终执行」', async () => {
    pending = [req()];
    await mount();
    expect(screen.queryByTestId('desktop-confirm-session')).toBeNull();
  });

  it('不能记住的请求没有「始终允许」', async () => {
    pending = [req({ rememberable: false })];
    await mount();
    expect(screen.queryByTestId('desktop-confirm-always')).toBeNull();
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

  it('按钮靠右：「详情」在最左，「始终允许」在「拒绝」前面，「允许」在最右', async () => {
    pending = [req()];
    await mount();
    const ids = [...screen.getByTestId('desktop-confirm-card').querySelectorAll('button')]
      .map((b) => b.getAttribute('data-testid'))
      .filter(Boolean);
    expect(ids.slice(-4)).toEqual([
      'desktop-confirm-details',
      'desktop-confirm-always',
      'desktop-confirm-deny',
      'desktop-confirm-allow',
    ]);
  });

  it('辅助模型审核过但没放行：显示风险等级与理由', async () => {
    pending = [
      req({
        tool: 'workspace_run',
        danger: 'destructive',
        review: { risk: 'high', rationale: '会删掉整个 build 目录' },
      }),
    ];
    await mount();
    const note = screen.getByTestId('desktop-confirm-review');
    expect(note.getAttribute('data-risk')).toBe('high');
    expect(note.textContent).toContain('高风险');
    expect(note.textContent).toContain('会删掉整个 build 目录');
    expect(screen.getByTestId('desktop-confirm-review-notice').textContent).toContain(
      '命令全文会发送给审核模型',
    );
  });

  it('命令能记进白名单：「始终允许」的提示写明前缀，点了照常经契约答复', async () => {
    pending = [req({ tool: 'workspace_run', danger: 'destructive', rememberRule: 'pnpm test' })];
    await mount();
    // 「始终允许」的范围写在悬停提示里
    const always = screen.getByTestId('desktop-confirm-always');
    expect(always.getAttribute('title')).toContain('pnpm test');
    expect(always.getAttribute('title')).toContain('以后不再询问以此开头的命令');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(() => vi.advanceTimersByTimeAsync(1100));
    fireEvent.click(screen.getByTestId('desktop-confirm-always'));
    await act(() => fake.settle());
    expect(fake.inputs('desktop.confirmAnswer')).toEqual([
      { id: 'c1', allow: true, remember: true, pick: false },
    ]);
  });
});
