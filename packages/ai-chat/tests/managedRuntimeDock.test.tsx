// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import {
  backendName,
  ManagedRuntimePanel,
  type ManagedRuntimeView,
} from '../src/components/ManagedRuntimeDock/panel';

const choice = (
  id: string,
  status: ManagedRuntimeView['choices'][number]['status'],
  available = false,
): ManagedRuntimeView['choices'][number] => ({
  id,
  available,
  status,
  detail: status,
  login: id === 'api' ? 'not-applicable' : available ? 'unverified' : 'not-advertised',
  requiresProject: id !== 'api',
  degraded: [],
});

afterEach(cleanup);

it('renders nothing when unmanaged or idle with no alerts or active tools', () => {
  const { container, rerender } = render(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: false,
        backend: '',
        phase: 'idle',
        recovery: 'none',
        generation: 0,
        detail: '',
        choices: [choice('api', 'requires-provider', true), choice('claude', 'ready', true)],
        busy: false,
      }}
      onResolve={vi.fn()}
    />,
  );
  expect(container.firstChild).toBeNull();

  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'claude',
        phase: 'idle',
        recovery: 'resumed',
        generation: 8,
        detail: '',
        choices: [choice('claude', 'ready', true), choice('api', 'requires-provider', true)],
        busy: false,
      }}
      onResolve={vi.fn()}
    />,
  );
  expect(container.firstChild).toBeNull();
});

it('surfaces unknown recovery prompt on demand and triggers new-native decision', () => {
  const onResolve = vi.fn();
  render(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'codex',
        phase: 'uncertain',
        recovery: 'unknown',
        generation: 4,
        detail: 'cold thread/resume unproven',
        choices: [choice('codex', 'ready', true)],
        busy: true,
      }}
      onResolve={onResolve}
    />,
  );
  expect(screen.getByTestId('managed-runtime-guidance').textContent).toMatch(/Codex/);
  expect(screen.getByTestId('managed-runtime-new-native').textContent).toMatch(/Codex/);
  fireEvent.click(screen.getByTestId('managed-runtime-new-native'));
  expect(onResolve).toHaveBeenCalledWith('new-native');
});

it('renders approval metadata, running trace, recovery actions, and dismissible error on demand', () => {
  const onApprove = vi.fn();
  const onResolve = vi.fn();
  const onRetry = vi.fn();
  const onDismissError = vi.fn();
  const { rerender } = render(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'api',
        phase: 'running',
        recovery: 'none',
        generation: 10,
        detail: '',
        choices: [choice('api', 'requires-provider', true)],
        busy: true,
        trace: [{ id: 'tr-1', kind: 'tool', tool: 'fs_write_text', status: 'running', at: 1 }],
        approvalDetails: [
          {
            id: 'ap-1',
            tool: 'workspace_run',
            summary: 'Run unit tests',
            argsPreview: '{"command":"go test"}',
            danger: 'destructive',
            risk: 'medium',
            rationale: 'Executes workspace command',
          },
        ],
      }}
      onResolve={onResolve}
      onApprove={onApprove}
      onRetry={onRetry}
      onDismissError={onDismissError}
    />,
  );
  expect(screen.getByTestId('managed-runtime-trace').textContent).toContain('fs_write_text');
  expect(screen.getByTestId('managed-approval-item-ap-1').textContent).toContain('workspace_run');
  fireEvent.click(screen.getByTestId('managed-approval-allow-ap-1'));
  expect(onApprove).toHaveBeenCalledWith('ap-1', true);
  fireEvent.click(screen.getByTestId('managed-approval-deny-ap-1'));
  expect(onApprove).toHaveBeenCalledWith('ap-1', false);

  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'api',
        phase: 'uncertain',
        recovery: 'error',
        generation: 11,
        detail: 'network interrupted',
        error: 'failed before send',
        choices: [choice('api', 'requires-provider', true)],
        busy: false,
        pendingSwitch: { phase: 'handoff', fromBackend: 'api', toBackend: 'claude' },
        failedRequest: { messageId: 'm-9', turnId: 't-9', text: 'retry this' },
      }}
      onResolve={onResolve}
      onApprove={onApprove}
      onRetry={onRetry}
      onDismissError={onDismissError}
    />,
  );
  expect(screen.getByTestId('managed-runtime-error').textContent).toBe('failed before send');
  fireEvent.click(screen.getByTestId('managed-runtime-error-dismiss'));
  expect(onDismissError).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('managed-runtime-rollback-switch'));
  expect(onResolve).toHaveBeenCalledWith('rollback-switch');
  fireEvent.click(screen.getByTestId('managed-runtime-retry'));
  expect(onRetry).toHaveBeenCalledWith({ messageId: 'm-9', turnId: 't-9', text: 'retry this' });

  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'api',
        phase: 'failed-pre-submit',
        recovery: 'error',
        generation: 12,
        detail: 'abandoned state',
        choices: [choice('api', 'requires-provider', true)],
        busy: false,
        failedRequest: { messageId: 'm-9', turnId: 't-9', text: 'retry this' },
      }}
      onResolve={onResolve}
      onApprove={onApprove}
      onRetry={onRetry}
    />,
  );
  fireEvent.click(screen.getByTestId('managed-runtime-abandon'));
  expect(onResolve).toHaveBeenCalledWith('abandon');
});

it('resolves display names for all builtin CLIs', () => {
  expect(backendName('gemini')).toBe('Gemini CLI');
  expect(backendName('grok')).toBe('Grok');
  expect(backendName('kimi')).toBe('Kimi Code');
  expect(backendName('minimax')).toBe('MiniMax Code');
  expect(backendName('dsh')).toBe('DeepSeek Harness');
});
