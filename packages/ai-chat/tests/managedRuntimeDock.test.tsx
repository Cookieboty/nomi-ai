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

it('renders nothing when unmanaged, idle, or busy only with trace entries', () => {
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

  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'antigravity',
        phase: 'running',
        recovery: 'new',
        generation: 9,
        detail: '',
        choices: [choice('antigravity', 'ready', true)],
        busy: true,
        trace: [
          { id: 'tr-run', kind: 'tool', tool: 'run_shell_command', status: 'running', at: 1 },
          { id: 'tr-done', kind: 'tool', tool: 'run_shell_command', status: 'completed', at: 2 },
        ],
      }}
      onResolve={vi.fn()}
    />,
  );
  expect(container.firstChild).toBeNull();
  expect(screen.queryByTestId('managed-runtime-trace')).toBeNull();

  // 手动停止或提交前失败后会话已回到空闲，不额外弹出「重新发送上次请求 / 放弃本次请求」条
  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'antigravity',
        phase: 'canceled',
        recovery: 'none',
        generation: 10,
        detail: '',
        choices: [choice('antigravity', 'ready', true)],
        busy: false,
        failedRequest: { messageId: 'm-1', turnId: 't-1', text: 'stopped request' },
      }}
      onResolve={vi.fn()}
    />,
  );
  expect(container.firstChild).toBeNull();
  expect(screen.queryByTestId('managed-runtime-retry')).toBeNull();
  expect(screen.queryByTestId('managed-runtime-abandon')).toBeNull();

  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'api',
        phase: 'failed-pre-submit',
        recovery: 'error',
        generation: 11,
        detail: 'pre-submit validation failed',
        choices: [choice('api', 'requires-provider', true)],
        busy: false,
        failedRequest: { messageId: 'm-2', turnId: 't-2', text: 'failed pre-submit' },
      }}
      onResolve={vi.fn()}
    />,
  );
  expect(container.firstChild).toBeNull();
  expect(screen.queryByTestId('managed-runtime-retry')).toBeNull();
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

it('renders approval metadata, recovery actions, and dismissible error without redundant tool trace banner', () => {
  const onApprove = vi.fn();
  const onResolve = vi.fn();
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
      onDismissError={onDismissError}
    />,
  );
  expect(screen.queryByTestId('managed-runtime-trace')).toBeNull();
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
      onDismissError={onDismissError}
    />,
  );
  expect(screen.queryByTestId('managed-runtime-retry')).toBeNull();
  expect(screen.queryByTestId('managed-runtime-abandon')).toBeNull();
  expect(screen.getByTestId('managed-runtime-error').textContent).toBe('failed before send');
  fireEvent.click(screen.getByTestId('managed-runtime-error-dismiss'));
  expect(onDismissError).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('managed-runtime-rollback-switch'));
  expect(onResolve).toHaveBeenCalledWith('rollback-switch');

  // 普通运行失败进入 uncertain 且无 pendingSwitch 时，彻底不渲染「放弃本次请求」区块
  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'claude',
        phase: 'uncertain',
        recovery: 'new',
        generation: 12,
        detail: 'abandoned state',
        choices: [choice('claude', 'ready', true)],
        busy: false,
        failedRequest: { messageId: 'm-9', turnId: 't-9', text: 'retry this' },
      }}
      onResolve={onResolve}
      onApprove={onApprove}
    />,
  );
  expect(screen.queryByTestId('managed-runtime-dock')).toBeNull();
  expect(screen.queryByTestId('managed-recovery-banner')).toBeNull();
  expect(screen.queryByTestId('managed-runtime-retry')).toBeNull();
  expect(screen.queryByTestId('managed-runtime-abandon')).toBeNull();
});

it('resolves display names for all builtin CLIs', () => {
  expect(backendName('gemini')).toBe('Gemini CLI');
  expect(backendName('grok')).toBe('Grok');
  expect(backendName('kimi')).toBe('Kimi Code');
  expect(backendName('minimax')).toBe('MiniMax Code');
  expect(backendName('antigravity')).toBe('Antigravity CLI');
  expect(backendName('dsh')).toBe('DeepSeek Harness');
});

it('collapses long approval preview by default and toggles expand/collapse', () => {
  const longArgs = '{"command":"' + 'echo long-step; '.repeat(20) + '"}';
  render(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'antigravity',
        phase: 'running',
        recovery: 'new',
        generation: 15,
        detail: '',
        choices: [choice('antigravity', 'ready', true)],
        busy: true,
        approvalDetails: [
          {
            id: 'ap-long',
            tool: 'run_shell',
            summary: 'Run shell script in sandbox',
            argsPreview: longArgs,
          },
        ],
      }}
      onResolve={vi.fn()}
      onApprove={vi.fn()}
    />,
  );
  const preview = screen.getByTestId('managed-approval-preview-ap-long');
  const toggle = screen.getByTestId('managed-approval-expand-ap-long');
  expect(preview.getAttribute('data-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  fireEvent.click(toggle);
  expect(preview.getAttribute('data-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-expanded')).toBe('true');

  fireEvent.click(toggle);
  expect(preview.getAttribute('data-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});
