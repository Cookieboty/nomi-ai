// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputerActivityBar } from '../src/components/ComputerActivityBar';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('对话窗口「正在操作桌面 · 停止」', () => {
  it('打开时读一次当前状态：已经有操作在进行就直接显示', async () => {
    installFakeApi({ 'computer.active': () => ({ active: ['Claude Code'] }) });
    const r = render(<ComputerActivityBar />);
    expect((await r.findByTestId('computer-activity-bar')).textContent).toContain('Claude Code');
  });

  it('收到 computer.activity 才出现；点停止调用 computer.stop 并收起', async () => {
    const fake = installFakeApi({
      'computer.stop': () => true,
      'computer.active': () => ({ active: [] }),
    });
    const r = render(<ComputerActivityBar />);
    expect(r.queryByTestId('computer-activity-bar')).toBeNull();
    await act(async () => {
      await fake.emit('computer.activity', { active: ['Nomi', 'Codex'] });
    });
    expect(r.getByTestId('computer-activity-bar').textContent).toContain('Nomi · Codex');
    fireEvent.click(r.getByTestId('computer-activity-stop'));
    await waitFor(() => expect(fake.calls.some(([n]) => n === 'computer.stop')).toBe(true));
    await waitFor(() => expect(r.queryByTestId('computer-activity-bar')).toBeNull());
  });
});
