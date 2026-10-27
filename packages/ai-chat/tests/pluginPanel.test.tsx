// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginPanel } from '../src/components/PluginPanel';
import { extClient } from '../src/services/extClient';

import { entry } from './slashHelpers';

afterEach(cleanup);

const entries = [
  entry({ id: 'project:command::fix', name: 'fix', description: '修 bug' }),
  entry({ id: 'user:skill::pdf', name: 'pdf', kind: 'skill', scope: 'user', description: 'PDF' }),
  entry({
    id: 'plugin:skill:acme:lint',
    name: 'acme:lint',
    kind: 'skill',
    scope: 'plugin',
    plugin: 'acme',
  }),
  entry({
    id: 'project:mcp::git',
    name: 'git',
    kind: 'mcp',
    transport: 'stdio',
    where: '.mcp.json',
  }),
  entry({ id: 'project:command::hidden', name: 'hidden', userInvocable: false }),
];

describe('PluginPanel（只读）', () => {
  it('按类别展示命令 / Skills / MCP，打开时触发刷新，且没有任何启停开关', () => {
    const onRefresh = vi.fn();
    const { getAllByTestId, getByText, container, queryAllByRole } = render(
      <PluginPanel
        isVisible
        onClose={vi.fn()}
        backend="claude"
        cwd="/work/app"
        entries={entries}
        onRefresh={onRefresh}
      />,
    );
    expect(onRefresh).toHaveBeenCalled();
    const names = () => getAllByTestId('plugin-panel-row').map((r) => r.textContent);
    expect(names().join('|')).toContain('/fix');
    expect(names().join('|')).toContain('仅模型调用');
    fireEvent.click(getByText(/^Skills/));
    expect(names().join('|')).toContain('/pdf');
    expect(names().join('|')).toContain('acme');
    fireEvent.click(getByText(/^MCP/));
    expect(names().join('|')).toContain('stdio');
    expect(container.ownerDocument.body.textContent).toContain('只读');
    expect(queryAllByRole('switch')).toHaveLength(0);
  });
  it('dsh：说明没有公开目录', () => {
    const { getByTestId } = render(
      <PluginPanel
        isVisible
        onClose={vi.fn()}
        backend="dsh"
        cwd="/w"
        entries={[]}
        onRefresh={vi.fn()}
      />,
    );
    expect(getByTestId('plugin-panel-empty').textContent).toContain('dsh');
  });

  it('Nomi：显示自己的 Skills / MCP 目录，不显示 dsh 的不支持提示（#143）', async () => {
    vi.spyOn(extClient, 'available').mockReturnValue(true);
    vi.spyOn(extClient, 'skills').mockResolvedValue([
      { name: 'summarize', description: '总结', builtin: true, enabled: true },
    ] as never);
    vi.spyOn(extClient, 'mcpList').mockResolvedValue({
      servers: [
        { id: 'fs', name: 'filesystem', transport: 'stdio', status: 'connected', tools: [{}] },
      ],
    } as never);
    const { findAllByTestId, getByText, queryByText } = render(
      <PluginPanel isVisible onClose={vi.fn()} backend="nomi" entries={[]} onRefresh={vi.fn()} />,
    );
    const rows = await findAllByTestId('plugin-panel-row');
    expect(rows.map((r) => r.textContent).join('|')).toContain('/summarize');
    expect(queryByText(/dsh/)).toBeNull();
    fireEvent.click(getByText(/^MCP/));
    expect(
      (await findAllByTestId('plugin-panel-row')).map((r) => r.textContent).join('|'),
    ).toContain('filesystem');
    vi.restoreAllMocks();
  });

  it('Nomi 没有数据：显示该类别的空状态而不是 dsh 提示', async () => {
    vi.spyOn(extClient, 'available').mockReturnValue(false);
    const { getByTestId } = render(
      <PluginPanel isVisible onClose={vi.fn()} backend="nomi" entries={[]} onRefresh={vi.fn()} />,
    );
    expect(getByTestId('plugin-panel-empty').textContent).not.toContain('dsh');
    vi.restoreAllMocks();
  });
});
