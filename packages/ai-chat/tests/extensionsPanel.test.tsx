// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExtensionsPanel } from '../src/components/ExtensionsPanel';
import { parseKv, splitArgs } from '../src/services/extClient';

import type { ApiMockState } from './helpers/knowledgeApi';

// ext.* 走契约（services/api）：调用记进 mockIpc 返回的 invoke（过程名 + 具名入参）
const mock = vi.hoisted(() => ({ transport: true }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(mock),
);

afterEach(() => {
  cleanup();
  mock.invoke = undefined;
});

const presets = [
  {
    key: 'memory',
    name: '知识图谱记忆',
    description: 'd',
    server: { transport: 'stdio', command: 'npx', args: ['-y', 'm'] },
    license: 'MIT',
  },
];

function mockIpc(servers: unknown[] = []) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch === 'ext.mcpList') return { servers, env: [], presets, ready: true };
    if (ch === 'ext.skillsList')
      return [
        {
          name: 'weekly-report',
          description: '写周报',
          enabled: true,
          builtin: true,
          files: [],
          dir: 'weekly-report',
        },
      ];
    if (ch === 'ext.mcpUpsert') return { id: 'mcp', ...(_a[0] as object) };
    return true;
  });
  mock.invoke = (name, input) => (input === undefined ? invoke(name) : invoke(name, input));
  return invoke;
}

describe('ExtensionsPanel', () => {
  it('shows presets when empty and saves a server from a preset', async () => {
    const invoke = mockIpc();
    const r = render(<ExtensionsPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByText('还没有 MCP 服务器')).toBeTruthy());
    fireEvent.click(r.getByTestId('mcp-preset-memory'));
    await waitFor(() =>
      expect((r.getByTestId('mcp-command') as HTMLInputElement).value).toBe('npx'),
    );
    fireEvent.click(r.getByTestId('mcp-save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'ext.mcpUpsert',
        expect.objectContaining({
          name: '知识图谱记忆',
          command: 'npx',
          args: ['-y', 'm'],
          trust: 'ask',
        }),
      ),
    );
  });
  it('lists connected server tools and skills', async () => {
    mockIpc([
      {
        id: 'w',
        name: '天气',
        transport: 'stdio',
        command: 'node',
        args: ['w.mjs'],
        enabled: true,
        trust: 'ask',
        origin: 'user',
        status: 'connected',
        tools: [
          { name: 'w__get_weather', description: '查天气', readOnly: true, dangerous: false },
        ],
      },
    ]);
    const r = render(<ExtensionsPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByText('已连接')).toBeTruthy());
    expect(r.getByText('已向模型提供 1 个扩展工具')).toBeTruthy();
    fireEvent.click(r.getAllByRole('tab')[1]);
    await waitFor(() => expect(r.getByText('weekly-report')).toBeTruthy());
    expect(r.getByText('内置示例')).toBeTruthy();
  });
  it('helpers', () => {
    expect(splitArgs('-y "a b" c')).toEqual(['-y', 'a b', 'c']);
    expect(parseKv('A=1\nbad\nB = x=y')).toEqual({ A: '1', B: 'x=y' });
  });
});

describe('ExtensionsPanel minimal OAuth UI', () => {
  const remote = {
    id: 'remote',
    name: 'Remote',
    transport: 'http',
    url: 'https://example.com/mcp',
    enabled: true,
    trust: 'ask',
    origin: 'user',
    status: 'authorization-required',
    tools: [],
  };
  it('offers explicit authorization without auto-opening a browser', async () => {
    const invoke = mockIpc([remote]);
    const r = render(<ExtensionsPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByText('需要授权')).toBeTruthy());
    expect(invoke).not.toHaveBeenCalledWith('ext.mcpAuthorize', expect.anything());
    fireEvent.click(r.getByRole('button', { expanded: false }));
    fireEvent.click(r.getByTestId('mcp-authorize'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ext.mcpAuthorize', { id: 'remote' }));
  });
  it('lets a pending browser authorization be cancelled', async () => {
    const invoke = mockIpc([{ ...remote, auth: 'pending' }]);
    const r = render(<ExtensionsPanel isVisible onClose={() => undefined} />);
    await waitFor(() =>
      expect(r.getByText('请在系统浏览器完成授权，完成后会自动连接。')).toBeTruthy(),
    );
    fireEvent.click(r.getByRole('button', { expanded: false }));
    expect(r.queryByTestId('mcp-authorize')).toBeNull();
    fireEvent.click(r.getByText('取消授权'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ext.mcpDisconnect', { id: 'remote' }));
  });
  it('keeps the original editor and round-trips the optional OAuth client ID', async () => {
    const invoke = mockIpc([{ ...remote, oauthClientId: 'existing-client' }]);
    const r = render(<ExtensionsPanel isVisible onClose={() => undefined} />);
    await waitFor(() => expect(r.getByText('Remote')).toBeTruthy());
    fireEvent.click(r.getByRole('button', { expanded: false }));
    fireEvent.click(r.getByText('编辑'));
    const input = r.getByTestId('mcp-oauth-client-id') as HTMLInputElement;
    expect(input.value).toBe('existing-client');
    fireEvent.change(input, { target: { value: 'custom-client' } });
    fireEvent.click(r.getByTestId('mcp-save'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'ext.mcpUpsert',
        expect.objectContaining({ oauthClientId: 'custom-client', url: remote.url }),
      ),
    );
  });
});
