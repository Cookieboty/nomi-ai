// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmDialog } from '../src/components/ConfirmDialog';
import { Markdown, resetChunkCache } from '../src/components/Conversation/Markdown';
import { ResourcePreview } from '../src/components/ResourcePreview/ResourcePreview';
import { OpenFileTab } from '../src/components/SideWorkspace/OpenFileTab';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import { useResourcePreview } from '../src/hooks/useResourcePreview';
import {
  persistWorkspaceTreeOpen,
  readWorkspaceTreeOpen,
  WORKSPACE_TREE_OPEN_KEY,
} from '../src/services/filesRailPrefs';
import { resourcePreviewClient } from '../src/services/resourcePreviewClient';
import {
  resetWorkspaceFileIndex,
  seedWorkspaceFileIndex,
} from '../src/services/workspaceFileIndex';

import { changeSource } from './helpers/codeView';
import { untilIdle } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    listDirectory: vi.fn(),
    save: vi.fn(),
    web: vi.fn(),
    close: vi.fn(async () => undefined),
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));

beforeAll(() => {
  (
    window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
  ).happyDOM.settings.disableIframePageLoading = true;
});

beforeEach(() => {
  localStorage.removeItem(WORKSPACE_TREE_OPEN_KEY);
  resetWorkspaceFileIndex();
  resetChunkCache();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Conversation file mentions & preview toolbar controls', () => {
  it('makes inline file paths and indexed basenames clickable while leaving code expressions untouched', () => {
    seedWorkspaceFileIndex('/repo', [
      'apps/desktop-go/internal/shell/wailsshell/wails.go',
      'packages/ai-chat/tests/browserTab.test.tsx',
    ]);
    const open = vi.fn();
    const scope = { id: 'nomi:1', cwd: '/repo' };

    const { container } = render(
      <ResourceScopeProvider value={{ scope, open }}>
        <Markdown
          settled
          text={[
            '- `wails.go`：在 `RawMessageHandler` 中校验 `origin != nil && !origin.IsMainFrame`，拒绝 `<iframe>`。',
            '- 新增 `packages/ai-chat/tests/browserTab.test.tsx` 与 `externalResource.test.tsx:18`，运行 `pnpm --filter @nomi-ai/ai-chat test` 和 `console.log`。',
            '- 显式链接 [`code label`](src/demo.go#L3-L5) 内部不重复包按钮。',
          ].join('\n')}
        />
      </ResourceScopeProvider>,
    );

    const fileChips = Array.from(container.querySelectorAll('code[data-file-code="true"]'));
    expect(fileChips.map((el) => el.textContent)).toEqual([
      'wails.go',
      'packages/ai-chat/tests/browserTab.test.tsx',
      'externalResource.test.tsx:18',
    ]);

    // 普通代码片段保持非交互 <code>
    const plainCodes = Array.from(
      container.querySelectorAll('code:not([data-file-code="true"])'),
    ).map((el) => el.textContent);
    expect(plainCodes).toEqual(
      expect.arrayContaining([
        'RawMessageHandler',
        'origin != nil && !origin.IsMainFrame',
        '<iframe>',
        'pnpm --filter @nomi-ai/ai-chat test',
        'console.log',
        'code label',
      ]),
    );

    // 点击已索引的裸文件名，直接定位到工作区内的完整路径
    fireEvent.click(fileChips[0]!);
    expect(open).toHaveBeenNthCalledWith(
      1,
      '/repo/apps/desktop-go/internal/shell/wailsshell/wails.go',
      { id: 'nomi:1', cwd: '/repo' },
      { origin: 'assistant' },
    );

    // 键盘回车同样可打开文件并保留行号定位
    fireEvent.keyDown(fileChips[2]!, { key: 'Enter' });
    expect(open).toHaveBeenNthCalledWith(2, 'externalResource.test.tsx:18', scope, {
      origin: 'assistant',
    });
  });

  it('resolves bare filenames via unique workspace suffix when missing at root', async () => {
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (cwd, input) => {
      if (cwd === '/repo' && input === 'wails.go') {
        return { ok: false, code: 'missing' };
      }
      if (cwd === '/repo' && input === '.../wails.go') {
        return {
          ok: true,
          kind: 'text',
          path: '/repo/apps/desktop-go/internal/shell/wailsshell/wails.go',
          content: 'package wailsshell\n',
          url: '/__nomi/preview/wails',
        };
      }
      return { ok: false, code: 'missing' };
    });

    render(
      <ResourcePreview
        entries={[{ key: 'w', href: 'wails.go', scope: { id: 'cli:1', cwd: '/repo' } }]}
        activeKey="w"
        expanded={false}
        originMismatch={false}
        onActive={vi.fn()}
        onCloseEntry={vi.fn()}
        onCloseEntries={vi.fn()}
        onExpanded={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    const source = await screen.findByTestId('resource-preview-source');
    expect(source.textContent).toContain('package wailsshell');
    expect(resourcePreviewClient.open).toHaveBeenNthCalledWith(1, '/repo', 'wails.go');
    expect(resourcePreviewClient.open).toHaveBeenNthCalledWith(2, '/repo', '.../wails.go');
  });

  it('refreshes the latest file content from disk and guards unsaved drafts', async () => {
    let version = 1;
    vi.mocked(resourcePreviewClient.open).mockImplementation(async () => ({
      ok: true,
      kind: 'text',
      path: '/repo/demo.ts',
      content: `export const v = ${version};\n`,
      editable: true,
      url: `/__nomi/preview/demo-${version}`,
      revision: String(version).repeat(64),
    }));
    vi.mocked(resourcePreviewClient.save).mockImplementation(
      () => new Promise(() => undefined), // 保持未完成的草稿以测试脏状态确认
    );

    render(
      <ResourcePreview
        entries={[
          { key: 'refresh-demo', href: '/repo/demo.ts', scope: { id: 'cli:1', cwd: '/repo' } },
        ]}
        activeKey="refresh-demo"
        expanded={false}
        originMismatch={false}
        onActive={vi.fn()}
        onCloseEntry={vi.fn()}
        onCloseEntries={vi.fn()}
        onExpanded={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    const source = await screen.findByTestId('resource-preview-source');
    expect(source.textContent).toContain('export const v = 1;');

    // 磁盘文件被外部更新为 v = 2，无脏草稿时点刷新直接拉取最新内容
    version = 2;
    fireEvent.click(screen.getByTestId('resource-preview-refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('resource-preview-source').textContent).toContain(
        'export const v = 2;',
      ),
    );
    expect(confirmDialog).not.toHaveBeenCalled();

    // 进入编辑并产生未保存草稿后点刷新：先询问确认，取消则保留草稿，确认则刷新为 v = 3
    fireEvent.click(screen.getByTestId('resource-preview-edit'));
    await untilIdle();
    changeSource(screen.getByTestId('resource-preview-source'), 'export const v = 999;\n');

    version = 3;
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId('resource-preview-refresh'));
    await untilIdle();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('resource-preview-source').textContent).toContain(
      'export const v = 999;',
    );

    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId('resource-preview-refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('resource-preview-source').textContent).toContain(
        'export const v = 3;',
      ),
    );
  });

  it('toggles showing and hiding the workspace file tree from the file toolbar', async () => {
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      path: '/repo/app.ts',
      content: 'console.info("ok");\n',
      url: '/__nomi/preview/app',
    });

    function Harness() {
      const preview = useResourcePreview({ id: 'nomi:tree', cwd: '/repo' });
      const controlRef = React.useRef(null);
      const [treeOpen, setTreeOpen] = React.useState(() => readWorkspaceTreeOpen());
      const toggleTree = () => {
        setTreeOpen((prev) => {
          const next = !prev;
          persistWorkspaceTreeOpen(next);
          return next;
        });
      };
      return (
        <>
          <button
            type="button"
            onClick={() => preview.value.open('/repo/app.ts', preview.value.scope)}
          >
            open-app
          </button>
          <OpenFileTab
            messages={[]}
            cwd="/repo"
            renderPreview={preview.renderEmbedded}
            expanded={false}
            onExpanded={vi.fn()}
            controlRef={controlRef}
            railSplit={{ width: 260, onPointerDown: vi.fn(), onDoubleClick: vi.fn() }}
            treeOpen={treeOpen}
            onToggleTree={toggleTree}
          />
        </>
      );
    }

    render(<Harness />);

    // 空状态始终可见目录树
    expect(screen.getByTestId('open-file-tree').hidden).toBe(false);

    // 打开文件后默认显示目录树：刷新与目录树开关固定在文件详情 tabs 右侧，面包屑栏不再重复出现编辑 / 全屏 / 关闭图标
    fireEvent.click(screen.getByText('open-app'));
    await screen.findByTestId('resource-preview-source');
    const tabbarActions = screen.getByTestId('resource-preview-tabbar-actions');
    const floatingActions = screen.getByTestId('preview-floating-actions');
    const toggleBtn = screen.getByTestId('resource-preview-toggle-tree');
    const refreshBtn = screen.getByTestId('resource-preview-refresh');
    expect(tabbarActions.contains(refreshBtn)).toBe(true);
    expect(tabbarActions.contains(toggleBtn)).toBe(true);
    expect(floatingActions.contains(refreshBtn)).toBe(false);
    expect(floatingActions.contains(toggleBtn)).toBe(false);
    expect(screen.queryByTestId('resource-preview-edit')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /放大预览|缩小预览|Expand preview|Collapse preview/ }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /关闭（Esc）|Close \(Esc\)/ })).toBeNull();
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('open-file-tree').hidden).toBe(false);
    expect(screen.getByTestId('open-file-page-splitter').hidden).toBe(false);

    // 点击隐藏目录树：先进入退场动画，完成后隐藏目录栏，偏好持久化
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('open-file-page-splitter').hidden).toBe(true);
    expect(readWorkspaceTreeOpen()).toBe(false);
    await waitFor(() => expect(screen.getByTestId('open-file-tree').hidden).toBe(true));

    // 再次点击恢复显示目录树
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('open-file-tree').hidden).toBe(false);
    expect(readWorkspaceTreeOpen()).toBe(true);
  });
});
