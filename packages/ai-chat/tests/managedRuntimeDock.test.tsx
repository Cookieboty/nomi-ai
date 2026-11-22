// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import {
  ManagedRuntimePanel,
  type ManagedRuntimeView,
} from '../src/components/ManagedRuntimeDock/panel';

const choice = (
  id: 'claude' | 'api',
  status: ManagedRuntimeView['choices'][number]['status'],
  available = false,
): ManagedRuntimeView['choices'][number] => ({
  id,
  available,
  status,
  detail: status,
  login: id === 'api' ? 'not-applicable' : available ? 'unverified' : 'not-advertised',
  requiresProject: id === 'claude',
  degraded: [],
});

afterEach(cleanup);

it('first-use shows providerless guidance and does not enable a missing executable', async () => {
  const onAdopt = vi.fn();
  render(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: false,
        backend: '',
        phase: 'idle',
        recovery: 'none',
        generation: 0,
        detail: '',
        choices: [choice('claude', 'missing-executable')],
        busy: false,
      }}
      onAdopt={onAdopt}
      onSelect={vi.fn()}
      onResolve={vi.fn()}
    />,
  );
  expect(screen.getByTestId('managed-runtime-guidance').textContent).toMatch(
    /PATH|登录|login|Install/i,
  );
  expect((screen.getByTestId('managed-runtime-adopt-claude') as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByTestId('managed-runtime-adopt-claude'));
  expect(onAdopt).not.toHaveBeenCalled();
});

it('no-project and unverified-login guidance is accurate, and unknown recovery requires an explicit new session', async () => {
  const onResolve = vi.fn();
  const onSelect = vi.fn();
  const { rerender } = render(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: false,
        backend: '',
        phase: 'idle',
        recovery: 'none',
        generation: 0,
        detail: '',
        choices: [choice('claude', 'no-project')],
        busy: false,
      }}
      onAdopt={vi.fn()}
      onSelect={onSelect}
      onResolve={onResolve}
    />,
  );
  expect(screen.getByTestId('managed-runtime-guidance').textContent).toMatch(/project|项目/);
  expect((screen.getByTestId('managed-runtime-adopt-claude') as HTMLButtonElement).disabled).toBe(
    true,
  );
  rerender(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'claude',
        phase: 'uncertain',
        recovery: 'unknown',
        generation: 7,
        detail: 'cold resume unproven',
        choices: [choice('claude', 'ready', true), choice('api', 'requires-provider', true)],
        busy: true,
      }}
      onAdopt={vi.fn()}
      onSelect={onSelect}
      onResolve={onResolve}
    />,
  );
  expect(screen.getByTestId('managed-runtime-guidance').textContent).toMatch(/new Claude|新建/);
  expect((screen.getByTestId('managed-runtime-select-api') as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByTestId('managed-runtime-select-api'));
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('managed-runtime-new-native'));
  expect(onResolve).toHaveBeenCalledTimes(1);
});

it('idle-only select is enabled after an explicit new-native decision', async () => {
  const onSelect = vi.fn();
  render(
    <ManagedRuntimePanel
      view={{
        supported: true,
        managed: true,
        backend: 'claude',
        phase: 'idle',
        recovery: 'none',
        generation: 8,
        detail: '',
        choices: [choice('claude', 'ready', true), choice('api', 'requires-provider', true)],
        busy: false,
      }}
      onAdopt={vi.fn()}
      onSelect={onSelect}
      onResolve={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTestId('managed-runtime-select-api'));
  expect(onSelect).toHaveBeenCalledWith('api');
});
