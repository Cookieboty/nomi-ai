// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutoApproveSetting } from '../src/components/ProvidersPage/AutoApproveSetting';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { HarnessTabsState } from '../src/services/harnessClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

function setup(autoApprove: boolean) {
  const state: HarnessTabsState = {
    tabs: [],
    activeTabId: 'main',
    running: 0,
    queued: 0,
    defaultPermissionMode: 'acceptEdits',
    autoApprove,
  };
  const invoke = vi.fn(async (ch: string, input?: { autoApprove?: boolean }) => {
    if (ch === 'harness.tabs') return state;
    if (ch === 'harness.permissionDefaults') {
      state.autoApprove = input?.autoApprove ?? state.autoApprove;
      return { ...state };
    }
    return {};
  });
  installFakeApi(invoke);
  return invoke;
}
const mount = () =>
  render(
    <HarnessTabsProvider>
      <AutoApproveSetting />
    </HarnessTabsProvider>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetFakeApi();
});

describe('AutoApproveSetting', () => {
  it('is on by default; turning it off goes back to asking without a confirmation', async () => {
    const invoke = setup(true);
    const confirm = vi.fn(() => true);
    (window as unknown as { confirm: unknown }).confirm = confirm;
    const r = mount();
    const sw = await r.findByTestId('auto-approve');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.permissionDefaults', { autoApprove: false }),
    );
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(r.getByTestId('auto-approve').getAttribute('aria-checked')).toBe('false'),
    );
  });

  it('turning it on asks first; cancelling keeps it off', async () => {
    const invoke = setup(false);
    const confirm = vi.fn(() => false);
    (window as unknown as { confirm: unknown }).confirm = confirm;
    const r = mount();
    fireEvent.click(await r.findByTestId('auto-approve'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls.some((c) => c[0] === 'harness.permissionDefaults')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(r.getByTestId('auto-approve'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('harness.permissionDefaults', { autoApprove: true }),
    );
  });
});
