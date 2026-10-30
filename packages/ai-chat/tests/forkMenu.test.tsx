// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ForkTargetMenu } from '../src/components/ForkMenu';

vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    state: vi.fn(async () => ({ bins: { claude: '/bin/claude', gemini: '/bin/gemini' } })),
  },
}));
vi.mock('../src/components/WorkspacePicker', () => ({ WorkspacePicker: () => null }));

afterEach(cleanup);

describe('ForkTargetMenu: 选择带入几轮上下文', () => {
  it('同端分叉：只选轮数，不列目标端，确认后带上轮数', () => {
    const onPick = vi.fn();
    render(<ForkTargetMenu open mode="same" current="codex" onPick={onPick} onClose={() => {}} />);
    expect(screen.queryByTestId('fork-target-claude')).toBeNull();
    fireEvent.change(screen.getByTestId('fork-turns'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('fork-confirm'));
    expect(onPick).toHaveBeenCalledWith('codex', { turns: 5 });
  });

  it('默认带最近 20 轮；可选全部；跨端分叉选目标时带上轮数', async () => {
    const onPick = vi.fn();
    render(<ForkTargetMenu open current="codex" onPick={onPick} onClose={() => {}} />);
    expect(screen.queryByTestId('fork-confirm')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('fork-target-gemini').hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByTestId('fork-target-gemini'));
    expect(onPick).toHaveBeenLastCalledWith('gemini', { cwd: undefined, turns: 20 });
    fireEvent.change(screen.getByTestId('fork-turns'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('fork-target-claude'));
    expect(onPick).toHaveBeenLastCalledWith('claude', { cwd: undefined, turns: 3 });
    fireEvent.change(screen.getByTestId('fork-turns'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('fork-target-claude'));
    expect(onPick).toHaveBeenLastCalledWith('claude', { cwd: undefined, turns: undefined });
  });
});
