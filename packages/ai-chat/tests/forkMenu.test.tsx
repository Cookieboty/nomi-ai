// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ForkDialog } from '../src/components/ForkMenu';
import { __setProjectsForTest } from '../src/services/projects';
import { cutAfter, FORK_TURN_CHOICES } from '../src/utils/forkTranscript';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    state: vi.fn(async () => ({ bins: { claude: '/bin/claude', gemini: '/bin/gemini' } })),
    recentCwds: vi.fn(async () => []),
  },
}));

afterEach(cleanup);

const mount = (props: Partial<React.ComponentProps<typeof ForkDialog>> = {}) => {
  const onPick = vi.fn();
  render(
    <ForkDialog open current="codex" allowCross onPick={onPick} onClose={() => {}} {...props} />,
  );
  return onPick;
};

describe('ForkDialog: one dialog for a new session or another endpoint', () => {
  it('defaults to a new session on the same endpoint with the last 20 turns', () => {
    const onPick = mount();
    expect(screen.getByTestId('fork-target-codex').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('fork-target-codex').textContent).toContain('新会话');
    fireEvent.click(screen.getByTestId('fork-confirm'));
    expect(onPick).toHaveBeenCalledWith('codex', { turns: 20 });
  });

  it('picks another endpoint, turns and project; not-installed endpoints are disabled', async () => {
    __setProjectsForTest([
      { id: 'p1', name: 'one', primary: '/p/one', folders: [], createdAt: 1, updatedAt: 1 },
    ]);
    const onPick = mount();
    await waitFor(() =>
      expect(screen.getByTestId('fork-target-gemini').hasAttribute('disabled')).toBe(false),
    );
    expect(screen.getByTestId('fork-target-dsh').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('fork-target-gemini'));
    fireEvent.change(screen.getByTestId('fork-turns'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('fork-project-button'));
    fireEvent.click(await screen.findByTestId('project-picker-item'));
    fireEvent.click(screen.getByTestId('fork-confirm'));
    expect(onPick).toHaveBeenCalledWith('gemini', { turns: undefined, projectId: 'p1' });
  });

  it('normal mode lists only the new session; forking from a reply says later messages are left out', () => {
    mount({ allowCross: false, current: 'nomi', fromMessage: true });
    expect(screen.queryByTestId('fork-target-claude')).toBeNull();
    expect(screen.getByTestId('fork-target-menu').textContent).toContain('之后的消息不带');
  });

  it('turn choices no longer include a single turn', () => {
    expect([...FORK_TURN_CHOICES]).toEqual([20, 10, 5, 3]);
  });
});

describe('cutAfter', () => {
  it('keeps messages up to and including the chosen one; unknown ids keep all', () => {
    const list = [{ id: 'u1' }, { id: 'a1' }, { id: 'u2' }, { id: 'a2' }];
    expect(cutAfter(list, 'a1').map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(cutAfter(list, 'x')).toHaveLength(4);
    expect(cutAfter(list)).toHaveLength(4);
  });
});
