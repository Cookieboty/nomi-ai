// @vitest-environment happy-dom
/** 设置 →「Nomi」→ 权限：工作区文件操作免确认（没单独设过时跟随「全部自动」）、命令自动审核 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NomiPermissionSettings } from '../src/components/SettingsView/NomiPermissionSettings';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabsState } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

type Patch = { aiReview?: boolean; nomiAutoApprove?: boolean };

function setup(init: Partial<HarnessTabsState> = {}) {
  const state: HarnessTabsState = {
    tabs: [],
    activeTabId: 'main',
    running: 0,
    queued: 0,
    defaultPermissionMode: 'acceptEdits',
    autoApprove: true,
    ...init,
  };
  const box: { fake: ReturnType<typeof installFakeApi> | null } = { fake: null };
  const invoke = vi.fn(async (ch: string, input?: Patch) => {
    if (ch === 'harness.tabs') return { ...state };
    if (ch === 'harness.permissionDefaults') {
      // 与内核一致：aiReview 只在关掉时出现；nomiAutoApprove 设过就出现
      if (input?.aiReview === false) state.aiReview = false;
      if (input?.aiReview === true) delete state.aiReview;
      if (typeof input?.nomiAutoApprove === 'boolean')
        state.nomiAutoApprove = input.nomiAutoApprove;
      const next = { ...state };
      queueMicrotask(() => void box.fake?.emit('harness.tabsChanged', next));
      return next;
    }
    return {};
  });
  box.fake = installFakeApi(invoke);
  return invoke;
}

const mount = () =>
  render(
    <HarnessTabsProvider>
      <NomiPermissionSettings />
    </HarnessTabsProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('NomiPermissionSettings', () => {
  it('工作区文件操作：没单独设过时跟随「全部自动」；关掉不用确认，打开要确认', async () => {
    const invoke = setup({ autoApprove: false });
    const confirm = vi.fn(() => true);
    (window as unknown as { confirm: unknown }).confirm = confirm;
    const r = mount();
    const sw = await r.findByTestId('nomi-auto-approve');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.permissionDefaults', { nomiAutoApprove: true }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(r.getByTestId('nomi-auto-approve').getAttribute('aria-checked')).toBe('true'),
    );
    fireEvent.click(r.getByTestId('nomi-auto-approve'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.permissionDefaults', { nomiAutoApprove: false }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('打开时取消确认：不改', async () => {
    const invoke = setup({ autoApprove: false });
    (window as unknown as { confirm: unknown }).confirm = vi.fn(() => false);
    const r = mount();
    fireEvent.click(await r.findByTestId('nomi-auto-approve'));
    await new Promise((x) => setTimeout(x, 0));
    expect(invoke).not.toHaveBeenCalledWith('harness.permissionDefaults', expect.anything());
  });

  it('命令自动审核：缺省为开，关掉 / 再打开不用确认', async () => {
    const invoke = setup();
    const confirm = vi.fn(() => true);
    (window as unknown as { confirm: unknown }).confirm = confirm;
    const r = mount();
    const sw = await r.findByTestId('ai-review');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.permissionDefaults', { aiReview: false }),
    );
    await waitFor(() =>
      expect(r.getByTestId('ai-review').getAttribute('aria-checked')).toBe('false'),
    );
    fireEvent.click(r.getByTestId('ai-review'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.permissionDefaults', { aiReview: true }),
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});
