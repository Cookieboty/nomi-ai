// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalCommandsCard } from '../src/components/ModelsPage/TerminalCommandsCard';
import type { TerminalCommandsState } from '../src/services/terminalCommandsClient';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const base: TerminalCommandsState = {
  enabled: false,
  pathAdded: false,
  binDir: '/home/u/.nomi/bin',
  rcFiles: ['/home/u/.zshrc'],
  pathSupported: true,
  commands: ['nomi-claude', 'nomi-codex', 'nomi-gemini', 'nomi-grok', 'nomi-dsh'],
};

function mockIpc(initial: Partial<TerminalCommandsState> = {}) {
  let st: TerminalCommandsState = { ...base, ...initial };
  const invoke = vi.fn(async (ch: string, input?: { enabled: boolean; addToPath?: boolean }) => {
    if (ch === 'gateway.terminalSet' && input) {
      st = {
        ...st,
        enabled: input.enabled,
        pathAdded: input.enabled ? (input.addToPath ?? st.pathAdded) : false,
      };
    }
    return st;
  });
  installFakeApi(invoke);
  return invoke;
}

const flush = () => act(async () => {});

describe('TerminalCommandsCard (§12.6)', () => {
  afterEach(() => {
    cleanup();
    resetFakeApi();
  });

  it('is off by default and explains the commands', async () => {
    mockIpc();
    render(<TerminalCommandsCard />);
    await flush();
    const sw = screen.getByRole('switch', { name: '终端启动命令' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/直接运行 claude、codex 仍是官方登录/)).toBeTruthy();
    expect(screen.queryByTestId('terminal-bin-dir')).toBeNull();
  });

  it('turning on shows the bin path; PATH changes only after confirmation', async () => {
    const invoke = mockIpc();
    render(<TerminalCommandsCard />);
    await flush();
    fireEvent.click(screen.getByRole('switch', { name: '终端启动命令' }));
    await flush();
    expect(invoke).toHaveBeenCalledWith('gateway.terminalSet', { enabled: true });
    expect(screen.getByTestId('terminal-bin-dir').textContent).toBe('/home/u/.nomi/bin');
    fireEvent.click(screen.getByText('加入 PATH…'));
    // 确认弹窗列出要改的文件，确认前不调用 addToPath
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByText('/home/u/.zshrc').length).toBeGreaterThan(0);
    expect(invoke).not.toHaveBeenCalledWith('gateway.terminalSet', {
      enabled: true,
      addToPath: true,
    });
    fireEvent.click(screen.getByTestId('terminal-path-confirm'));
    await flush();
    expect(invoke).toHaveBeenCalledWith('gateway.terminalSet', {
      enabled: true,
      addToPath: true,
    });
    expect(screen.getByTestId('terminal-path-status').textContent).toContain('已加入 PATH');
  });

  it('cancelling the dialog leaves the shell rc alone', async () => {
    const invoke = mockIpc({ enabled: true });
    render(<TerminalCommandsCard />);
    await flush();
    fireEvent.click(screen.getByText('加入 PATH…'));
    fireEvent.click(screen.getByText('取消'));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invoke.mock.calls.filter((c) => c[0] === 'gateway.terminalSet')).toHaveLength(0);
  });

  it('Windows: shows the folder to add manually, no PATH button', async () => {
    mockIpc({ enabled: true, pathSupported: false, rcFiles: [], commands: ['nomi-claude.cmd'] });
    render(<TerminalCommandsCard />);
    await flush();
    expect(screen.getByTestId('terminal-path-status').textContent).toContain('手动添加');
    expect(screen.queryByText('加入 PATH…')).toBeNull();
  });

  it('turning off calls set with enabled=false', async () => {
    const invoke = mockIpc({ enabled: true, pathAdded: true });
    render(<TerminalCommandsCard />);
    await flush();
    fireEvent.click(screen.getByRole('switch', { name: '终端启动命令' }));
    await flush();
    expect(invoke).toHaveBeenCalledWith('gateway.terminalSet', { enabled: false });
    expect(screen.queryByTestId('terminal-bin-dir')).toBeNull();
  });
});
