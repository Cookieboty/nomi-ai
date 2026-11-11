// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import type { Meta } from '../src/components/Sidebar/types';
import { useSessionActions } from '../src/components/Sidebar/useSessionActions';
import { historyClient, type HistorySession } from '../src/services/historyClient';

vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn() }));
vi.mock('../src/services/historyClient', () => ({
  isHistoryBackend: (backend: string) => ['claude', 'codex', 'gemini'].includes(backend),
  historyClient: { delete: vi.fn(), deleteTab: vi.fn(), open: vi.fn() },
}));
const meta = {
  id: 'conversation',
  tabId: 'tab',
  name: 'Running task',
  backend: 'claude',
  cliSessionId: 'native',
} as Meta;
const history = { backend: 'claude', sessionId: 'native', title: 'Running task' } as HistorySession;
function setup() {
  const deps = {
    tabs: { close: vi.fn(async () => undefined) },
    onNotice: vi.fn(),
    refresh: vi.fn(),
    refreshHistory: vi.fn(),
  };
  return { ...renderHook(() => useSessionActions(deps)), deps };
}
beforeEach(() => {
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.mocked(historyClient.delete).mockResolvedValue({ ok: true, removed: 1 });
  vi.mocked(historyClient.deleteTab).mockResolvedValue({ ok: true, removed: 1 });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('confirmed CLI session deletion', () => {
  it('delegates native session deletion and process shutdown to one kernel operation', async () => {
    const { result, deps } = setup();
    await act(() => result.current.deleteTab(meta));
    expect(historyClient.deleteTab).toHaveBeenCalledWith('tab');
    expect(historyClient.delete).not.toHaveBeenCalled();
    expect(deps.tabs.close).not.toHaveBeenCalled();
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.refreshHistory).toHaveBeenCalledOnce();
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        danger: true,
        message: expect.stringContaining('永久删除'),
        confirmLabel: expect.stringContaining('永久删除'),
      }),
    );
  });
  it('cancelling deletion leaves both history and the running tab untouched', async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const { result, deps } = setup();
    await act(() => result.current.deleteTab(meta));
    await act(() => result.current.deleteHistory(history));
    expect(historyClient.delete).not.toHaveBeenCalled();
    expect(historyClient.deleteTab).not.toHaveBeenCalled();
    expect(deps.tabs.close).not.toHaveBeenCalled();
  });
  it('deleting a stale history row also uses kernel shutdown, without requiring a tab id', async () => {
    const { result, deps } = setup();
    await act(() => result.current.deleteHistory(history));
    expect(historyClient.delete).toHaveBeenCalledWith('claude', 'native');
    expect(deps.tabs.close).not.toHaveBeenCalled();
    expect(deps.refreshHistory).toHaveBeenCalledOnce();
  });
  it('lets the kernel resolve tabs whose native identity is missing from the sidebar', async () => {
    const { result, deps } = setup();
    await act(() => result.current.deleteTab({ ...meta, cliSessionId: undefined }));
    expect(historyClient.deleteTab).toHaveBeenCalledWith('tab');
    expect(deps.tabs.close).not.toHaveBeenCalled();
    expect(historyClient.delete).not.toHaveBeenCalled();
  });
  it('deletes by stable tab id when the native identity arrives during confirmation', async () => {
    let confirm!: (accepted: boolean) => void;
    vi.mocked(confirmDialog).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const { result } = setup();
    const snapshot = { ...meta, cliSessionId: undefined };
    let deletion!: Promise<void>;
    act(() => {
      deletion = result.current.deleteTab(snapshot);
    });
    expect(historyClient.deleteTab).not.toHaveBeenCalled();
    // A newer sidebar row can now have a native ID; the pending call still holds snapshot.
    await act(async () => {
      confirm(true);
      await deletion;
    });
    expect(historyClient.deleteTab).toHaveBeenCalledWith('tab');
    expect(historyClient.delete).not.toHaveBeenCalled();
  });
  it('reports kernel shutdown failures and refreshes the list without a second close', async () => {
    vi.mocked(historyClient.deleteTab).mockResolvedValue({
      ok: false,
      error: 'could not stop process',
    });
    const { result, deps } = setup();
    await act(() => result.current.deleteTab(meta));
    expect(deps.onNotice).toHaveBeenCalledWith('could not stop process');
    expect(deps.tabs.close).not.toHaveBeenCalled();
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.refreshHistory).toHaveBeenCalledOnce();
  });
});
