// @vitest-environment happy-dom
/** #58：「从其他工具导入」对话框：列表、预览、默认勾选、同名冲突选择、导入结果 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExtensionsPanel } from '../src/components/ExtensionsPanel';
import { MigrateDialog } from '../src/components/ExtensionsPanel/MigrateDialog';

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

const scan = {
  project: null,
  sources: [{ tool: 'claude', where: '~/.claude.json', found: true }],
  mcp: [
    {
      key: 'claude:user:mcp:github',
      kind: 'mcp',
      tool: 'claude',
      scope: 'user',
      name: 'github',
      where: '~/.claude.json',
      warnings: [],
      conflict: false,
      preview: { transport: 'stdio', command: 'npx', env: { TOKEN: 'gh••••••' } },
    },
    {
      key: 'claude:user:mcp:files',
      kind: 'mcp',
      tool: 'claude',
      scope: 'user',
      name: 'files',
      where: '~/.claude.json',
      warnings: ['含环境变量引用 ${X}'],
      conflict: true,
      preview: { transport: 'stdio', command: 'fs' },
    },
    {
      key: 'claude:user:mcp:ws',
      kind: 'mcp',
      tool: 'claude',
      scope: 'user',
      name: 'ws',
      where: '~/.claude.json',
      warnings: [],
      error: 'Nomi 暂不支持 ws 类型的 MCP 服务器',
      conflict: false,
    },
  ],
  skills: [
    {
      key: 'codex:user:skill:~/.agents/skills/review',
      kind: 'skill',
      tool: 'codex',
      scope: 'user',
      name: 'review',
      where: '~/.agents/skills/review',
      warnings: [],
      conflict: false,
      preview: { description: 'Code review', files: ['ref.md'], bytes: 2048 },
    },
  ],
};

function mockIpc(s: unknown = scan) {
  const invoke = vi.fn(async (ch: string, ..._a: unknown[]) => {
    if (ch === 'ext.migrateScan') return s;
    if (ch === 'ext.migrateImport')
      return {
        imported: [{ key: 'claude:user:mcp:github', kind: 'mcp', name: 'github' }],
        skipped: [],
        failed: [{ key: 'x', name: 'files', error: '安全存储不可用' }],
      };
    if (ch === 'ext.mcpList') return { servers: [], env: [], presets: [], ready: true };
    if (ch === 'ext.skillsList') return [];
    return true;
  });
  mock.invoke = (name, input) => (input === undefined ? invoke(name) : invoke(name, input));
  return invoke;
}

describe('MigrateDialog', () => {
  it('默认只勾选无冲突、无错误的项；冲突项可选重命名；导入后显示结果', async () => {
    const invoke = mockIpc();
    const onDone = vi.fn();
    const r = render(<MigrateDialog open onClose={() => undefined} onDone={onDone} />);
    await waitFor(() => expect(r.getByText('github')).toBeTruthy());
    const check = (k: string) => r.getByTestId(`migrate-check-${k}`) as HTMLInputElement;
    expect(check('claude:user:mcp:github').checked).toBe(true);
    expect(check('claude:user:mcp:files').checked).toBe(false);
    expect(check('claude:user:mcp:ws').disabled).toBe(true);
    expect(r.getByText('Nomi 暂不支持 ws 类型的 MCP 服务器')).toBeTruthy();
    expect(r.getByText('已有同名')).toBeTruthy();
    expect(r.getByTestId('migrate-import').textContent).toContain('2');

    // 预览
    fireEvent.click(r.getAllByText('预览')[0]!);
    expect(r.getByTestId('migrate-preview-claude:user:mcp:github').textContent).toContain(
      'gh••••••',
    );

    // 勾上冲突项 → 出现处理方式，默认跳过，改成重命名
    fireEvent.click(check('claude:user:mcp:files'));
    fireEvent.click(r.getByRole('combobox'));
    fireEvent.click(document.querySelector('[data-value="rename"]')!);
    fireEvent.click(r.getByTestId('migrate-import'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ext.migrateImport', {
        items: [
          { key: 'claude:user:mcp:github', action: undefined },
          { key: 'claude:user:mcp:files', action: 'rename' },
          { key: 'codex:user:skill:~/.agents/skills/review', action: undefined },
        ],
      }),
    );
    await waitFor(() =>
      expect(r.getByTestId('migrate-result').textContent).toContain('安全存储不可用'),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('选择项目文件夹由主进程弹框；空结果有提示', async () => {
    const invoke = mockIpc({ project: null, sources: [], mcp: [], skills: [] });
    const r = render(<MigrateDialog open onClose={() => undefined} onDone={() => undefined} />);
    await waitFor(() => expect(r.getByTestId('migrate-empty')).toBeTruthy());
    fireEvent.click(r.getByTestId('migrate-pick-project'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ext.migrateScan', { pickProject: true }),
    );
  });

  it('扩展面板里有入口', async () => {
    const invoke = mockIpc();
    const r = render(<ExtensionsPanel isVisible onClose={() => undefined} />);
    fireEvent.click(await r.findByTestId('migrate-open'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ext.migrateScan', {}));
    await waitFor(() => expect(r.getByText('github')).toBeTruthy());
  });
});
