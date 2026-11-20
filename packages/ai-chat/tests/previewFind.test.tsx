// @vitest-environment happy-dom
import { t } from '@nomi-ai/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_FIND_MATCHES,
  documentTextIndex,
  findText,
  findTextMatches,
  replaceAllInText,
  replaceSingleInText,
} from '../src/components/ResourcePreview/fileFindIndex';
import { ResourcePreview } from '../src/components/ResourcePreview/ResourcePreview';
import { FileReview, type ReviewFile } from '../src/components/SessionWorkspace/FileReview';
import { harnessClient } from '../src/services/harnessClient';
import { resourcePreviewClient, type PreviewResult } from '../src/services/resourcePreviewClient';

import { changeSource, sourceEditable, sourceValue, sourceView } from './helpers/codeView';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../src/services/harnessClient', () => ({
  harnessClient: {
    workspaceRead: vi.fn(),
    workspaceWrite: vi.fn(),
    workspaceDelete: vi.fn(),
    workspaceGitCheckout: vi.fn(),
    gitDiff: vi.fn(),
  },
}));
vi.mock('../src/services/resourcePreviewClient', () => ({
  resourcePreviewClient: {
    open: vi.fn(),
    save: vi.fn(async () => ({ ok: true, revision: 'r2' })),
    web: vi.fn(),
    close: vi.fn(async () => undefined),
    external: vi.fn(async () => ({ ok: true, kind: 'external' })),
  },
}));

let sequence = 0;
const highlights = new Map<string, TestHighlight>();
class TestHighlight {
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
  ranges: Range[];
}
beforeEach(() => {
  localStorage.clear();
  highlights.clear();
  vi.stubGlobal('Highlight', TestHighlight);
  vi.stubGlobal('CSS', Object.assign(Object.create(CSS), { highlights }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const label = (suffix: string) => t(`ui.session-workspace.preview-find${suffix}`);
const input = () => screen.getByRole('textbox', { name: label('') });
const count = () => within(screen.getByRole('search')).getByRole('status').textContent;
const key = (shiftKey = false, extra: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    ctrlKey: true,
    shiftKey,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  fireEvent(window, e);
  return e;
};
const query = async (text: string) => {
  key();
  fireEvent.change(input(), { target: { value: text } });
  await waitFor(() => expect(count()).not.toBe('0 / 0'));
};
async function mount(
  result: PreviewResult = {
    ok: true,
    kind: 'markdown',
    content: '# Guide\n\nAlpha **beta** and alpha beta.\n\n```js\nconst value = 1;\n```',
  },
) {
  const id = `find-${sequence++}`;
  const entry = { key: id, href: `/w/${id}.md`, scope: { id: 'cli:a', cwd: '/w' } };
  vi.mocked(resourcePreviewClient.open).mockResolvedValue(result);
  const props = {
    entries: [entry],
    activeKey: entry.key,
    expanded: true,
    originMismatch: false,
    onActive: vi.fn(),
    onCloseEntry: vi.fn(),
    onCloseEntries: vi.fn(),
    onExpanded: vi.fn(),
    onOpen: vi.fn(),
  };
  const rendered = render(
    <>
      <p>alpha beta outside current file</p>
      <ResourcePreview {...props} />
    </>,
  );
  await waitFor(() =>
    expect(screen.queryByText(t('ui.session-workspace.preview-loading'))).toBeNull(),
  );
  return { ...rendered, props };
}

describe('literal file search index', () => {
  it('escapes regex, handles Unicode offsets, case and Chinese without rewriting text', () => {
    expect(findText('a.* A.*', 'a.*')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    expect(findText('İ中文😀x X', 'x')).toEqual([
      { start: 5, end: 6 },
      { start: 7, end: 8 },
    ]);
    expect(findText('中文 中文', '中文')).toHaveLength(2);
    expect(findText('anything', '')).toEqual([]);
  });
  it('bounds large-file matches without treating the query as a regular expression', () => {
    expect(findText('x'.repeat(20000), 'x')).toHaveLength(MAX_FIND_MATCHES + 1);
    expect(findText('abcabcabc', 'abc', 2)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });
  it('joins inline formatting, separates blocks and excludes line numbers and controls', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<p>Hello <b>world</b></p><p>Next</p><span aria-hidden="true">42</span><button>Hello</button><div data-preview-find-ignore>language</div>';
    const before = root.innerHTML;
    const index = documentTextIndex(root);
    const match = findText(index.text, 'hello world')[0]!;
    expect(index.range(match)?.toString()).toBe('Hello world');
    expect(index.text).toContain('world\nNext');
    expect(index.text).not.toMatch(/42|language/);
    expect(findText(index.text, 'hello')).toHaveLength(1);
    expect(root.innerHTML).toBe(before);
  });
});

describe('current preview file search', () => {
  it('counts only current rendered file, navigates/wraps and Esc closes find before preview', async () => {
    const { props, rerender } = await mount();
    const doc = screen.getByTestId('preview-markdown');
    const before = doc.querySelector('p')!.innerHTML;
    expect(key(true).defaultPrevented).toBe(false);
    expect(screen.queryByRole('search')).toBeNull();
    await query('ALPHA beta');
    expect(document.activeElement).toBe(input());
    expect(count()).toBe('1 / 2');
    expect(highlights.get('preview-find-matches')?.ranges.map((r) => r.toString())).toEqual([
      'Alpha beta',
      'alpha beta',
    ]);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(count()).toBe('2 / 2');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(count()).toBe('1 / 2');
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(count()).toBe('2 / 2');
    expect(doc.querySelector('p')!.innerHTML).toBe(before);
    expect(doc.querySelector('mark')).toBeNull();
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    const nativeSelection = window.getSelection()!;
    const selected = document.createRange();
    selected.selectNodeContents(doc.querySelector('strong')!);
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(selected);
    expect(nativeSelection.toString()).toBe('beta');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(highlights.size).toBe(0);
    expect(nativeSelection.rangeCount).toBe(0);
    expect(props.onCloseEntries).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('resource-preview'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onExpanded).toHaveBeenCalledWith(false);
    expect(props.onCloseEntries).not.toHaveBeenCalled();
    rerender(<ResourcePreview {...props} expanded={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onCloseEntries).toHaveBeenCalledWith([props.activeKey]);
  });
  it('reindexes on mode/file change; excludes code toolbar labels and read-only line numbers', async () => {
    const { props, rerender } = await mount();
    await query('js');
    expect(count()).toBe(label('-empty'));
    fireEvent.click(screen.getByTestId('resource-preview-mode'));
    await waitFor(() => expect(count()).toBe('1 / 1'));
    fireEvent.change(input(), { target: { value: '**' } });
    expect(count()).toBe('1 / 2');
    const entry = { ...props.entries[0]!, key: 'different', href: '/w/different.txt' };
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      kind: 'text',
      content: '** only once',
    });
    rerender(
      <>
        <p>alpha beta outside current file</p>
        <ResourcePreview {...props} entries={[...props.entries, entry]} activeKey="different" />
      </>,
    );
    await waitFor(() => expect(count()).toBe('1 / 1'));
    fireEvent.change(input(), { target: { value: '1' } });
    expect(count()).toBe(label('-empty'));
    expect(resourcePreviewClient.open).toHaveBeenCalledTimes(2);
  });
  it('searches the current source draft without changing editor value, selection or autosave', async () => {
    await mount({
      ok: true,
      kind: 'text',
      content: 'draft\nDraft\nend',
      editable: true,
      revision: 'r1',
      url: '/__nomi/preview/find-source',
    });
    fireEvent.click(screen.getByTestId('resource-preview-edit'));
    await waitFor(() =>
      expect(sourceEditable(screen.getByTestId('resource-preview-source'))).toBe(true),
    );
    const editor = sourceView(screen.getByTestId('resource-preview-source'));
    editor.focus();
    editor.dispatch({ selection: { anchor: 0, head: 5 } });
    await query('draft');
    expect(count()).toBe('1 / 2');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(editor.state.sliceDoc()).toBe('draft\nDraft\nend');
    expect(editor.state.selection.main.from).toBe(0);
    expect(
      screen
        .getByTestId('resource-preview')
        .querySelectorAll('.preview-code-find-match,.preview-code-find-current'),
    ).toHaveLength(2);
    expect(resourcePreviewClient.save).not.toHaveBeenCalled();
    changeSource(editor.scrollDOM, 'draft new draft draft');
    await waitFor(() => expect(count()).toBe('2 / 3'));
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(document.activeElement).toBe(editor.contentDOM);
    expect(editor.state.selection.main.from).toBe(0);
    expect(editor.state.selection.main.to).toBe(0);
    expect(editor.state.sliceDoc()).toBe('draft new draft draft');
  });
  it('uses macOS Command only; ignores IME, shortcut recording and modal dialogs', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await mount();
    expect(key(false, { isComposing: true }).defaultPrevented).toBe(false);
    expect(screen.queryByRole('search')).toBeNull();
    const recording = document.createElement('input');
    recording.dataset.shortcutRecording = 'true';
    document.body.append(recording);
    fireEvent.keyDown(recording, { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(screen.queryByRole('search')).toBeNull();
    recording.remove();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    key();
    expect(screen.queryByRole('search')).toBeNull();
    dialog.remove();
    expect(key(false, { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
    fireEvent.change(input(), { target: { value: 'alpha' } });
    input().blur();
    expect(key().defaultPrevented).toBe(false);
    expect(key(false, { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
    expect((input() as HTMLInputElement).selectionEnd).toBe(5);
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    expect(count()).toBe('1 / 2');
  });
  it('shows no-match/unavailable states without searching the conversation', async () => {
    await mount({ ok: false, code: 'missing' });
    key();
    expect(count()).toBe(label('-unavailable'));
    expect(screen.getByRole('button', { name: label('-next') }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('VS Code style find options, replace and hidden preview isolation', () => {
  it('supports case sensitivity, whole word (Unicode), regex and regex capture replacement helpers', () => {
    expect(findTextMatches('Foo foo FOO', 'foo', { caseSensitive: true }).matches).toEqual([
      { start: 4, end: 7 },
    ]);
    expect(
      findTextMatches('foo food _foo 中文foo foo', 'foo', { wholeWord: true }).matches,
    ).toEqual([
      { start: 0, end: 3 },
      { start: 20, end: 23 },
    ]);
    expect(findTextMatches('aab', 'a*', { regex: true }).matches).toEqual([{ start: 0, end: 2 }]);
    expect(findTextMatches('abc', '[unclosed', { regex: true }).error).toBeTruthy();

    // 字面模式不解析 $1，正则模式展开捕获组与转义换行
    const literal = replaceSingleInText('foo bar', { start: 0, end: 3 }, 'foo', '$1$$', {
      regex: false,
    });
    expect(literal.text).toBe('$1$$ bar');

    const regexAll = replaceAllInText(
      'user_1=10\nuser_2=20',
      'user_(\\d+)=(\\d+)',
      'id:$1\\nval:$2',
      {
        regex: true,
      },
    );
    expect(regexAll.count).toBe(2);
    expect(regexAll.text).toBe('id:1\nval:10\nid:2\nval:20');
  });

  it('ignores hidden/inactive preview instances so Cmd+F opens the active visible preview', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.mocked(resourcePreviewClient.open).mockImplementation(async (_cwd, path) => ({
      ok: true,
      kind: 'markdown',
      path,
      content: path.includes('hidden') ? 'hidden alpha' : 'visible alpha beta',
    }));
    const hiddenEntry = { key: 'h1', href: '/w/hidden.md', scope: { id: 'cli:a', cwd: '/w' } };
    const visibleEntry = { key: 'v1', href: '/w/visible.md', scope: { id: 'cli:a', cwd: '/w' } };

    render(
      <>
        <div hidden data-testid="hidden-wrap">
          <ResourcePreview
            entries={[hiddenEntry]}
            activeKey="h1"
            expanded={false}
            originMismatch={false}
            onActive={vi.fn()}
            onCloseEntry={vi.fn()}
            onCloseEntries={vi.fn()}
            onExpanded={vi.fn()}
            onOpen={vi.fn()}
          />
        </div>
        <div data-testid="visible-wrap">
          <ResourcePreview
            entries={[visibleEntry]}
            activeKey="v1"
            expanded={false}
            originMismatch={false}
            onActive={vi.fn()}
            onCloseEntry={vi.fn()}
            onCloseEntries={vi.fn()}
            onExpanded={vi.fn()}
            onOpen={vi.fn()}
          />
        </div>
      </>,
    );
    await waitFor(() => expect(screen.getByText('visible alpha beta')).toBeTruthy());

    key(false, { ctrlKey: false, metaKey: true });
    const visibleWrap = screen.getByTestId('visible-wrap');
    const hiddenWrap = screen.getByTestId('hidden-wrap');
    expect(within(hiddenWrap).queryByRole('search')).toBeNull();
    const search = within(visibleWrap).getByRole('search');
    const searchInput = within(search).getByRole('textbox', { name: label('') });
    expect(document.activeElement).toBe(searchInput);

    fireEvent.change(searchInput, { target: { value: 'visible' } });
    expect(within(search).getByRole('status').textContent).toBe('1 / 1');
    expect(highlights.get('preview-find-matches')?.ranges.map((r) => r.toString())).toEqual([
      'visible',
    ]);
  });

  it('supports match options, F3/Mod+G navigation and invalid regex feedback', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    await mount({
      ok: true,
      kind: 'text',
      content: 'Foo foo food\nFoo bar',
    });
    key();
    fireEvent.change(input(), { target: { value: 'Foo' } });
    expect(count()).toBe('1 / 4');

    fireEvent.click(screen.getByTestId('preview-find-case'));
    expect(count()).toBe('1 / 2');

    fireEvent.click(screen.getByTestId('preview-find-word'));
    expect(count()).toBe('1 / 2');

    fireEvent.click(screen.getByTestId('preview-find-case'));
    expect(count()).toBe('1 / 3');

    // F3 与 Mod+G 导航
    fireEvent.keyDown(window, { key: 'F3', bubbles: true, cancelable: true });
    expect(count()).toBe('2 / 3');
    fireEvent.keyDown(window, {
      key: 'g',
      code: 'KeyG',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(count()).toBe('3 / 3');
    fireEvent.keyDown(window, { key: 'F3', shiftKey: true, bubbles: true, cancelable: true });
    expect(count()).toBe('2 / 3');

    // 切到正则并校验非法正则错误状态（也测试 Alt+C / Alt+W / Alt+R 快捷键切换）
    fireEvent.keyDown(input(), {
      key: 'w',
      code: 'KeyW',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent.keyDown(input(), {
      key: 'r',
      code: 'KeyR',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent.change(input(), { target: { value: '[unclosed' } });
    expect(count()).toBe(label('-invalid-regex'));
    fireEvent.change(input(), { target: { value: '^Foo' } });
    expect(count()).toBe('1 / 2');
  });

  it('replaces single/all occurrences with undo in CodeMirror source editor and hides replace in read-only', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await mount({
      ok: true,
      kind: 'text',
      content: 'val_1 val_2 val_1',
      editable: true,
      revision: 'r1',
      url: '/__nomi/preview/replace-code',
    });

    // 只读 preview 模式不提供替换功能
    key(false, { ctrlKey: false, metaKey: true, altKey: true });
    expect(screen.queryByTestId('preview-find-toggle-replace')).toBeNull();
    expect(screen.queryByTestId('preview-find-replace-input')).toBeNull();
    fireEvent.keyDown(input(), { key: 'Escape' });

    // 进入编辑模式：Mac Mod+Alt+F 直接展开替换框并聚焦
    fireEvent.click(screen.getByTestId('resource-preview-edit'));
    await waitFor(() =>
      expect(sourceEditable(screen.getByTestId('resource-preview-source'))).toBe(true),
    );
    const editor = sourceView(screen.getByTestId('resource-preview-source'));

    fireEvent.keyDown(window, {
      key: 'f',
      code: 'KeyF',
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const replaceInput = screen.getByTestId('preview-find-replace-input') as HTMLInputElement;
    expect(document.activeElement).toBe(replaceInput);

    // 单个替换 + 平滑推进到下一个匹配
    fireEvent.change(input(), { target: { value: 'val_1' } });
    expect(count()).toBe('1 / 2');
    fireEvent.change(replaceInput, { target: { value: '$1_x' } });
    fireEvent.click(screen.getByTestId('preview-find-replace-one'));
    expect(sourceValue(editor.scrollDOM)).toBe('$1_x val_2 val_1');
    expect(count()).toBe('1 / 1');

    // 正则捕获组全部替换
    fireEvent.click(screen.getByTestId('preview-find-regex'));
    fireEvent.change(input(), { target: { value: 'val_(\\d+)' } });
    fireEvent.change(replaceInput, { target: { value: 'item_$1' } });
    expect(count()).toBe('1 / 2');
    fireEvent.click(screen.getByTestId('preview-find-replace-all'));
    expect(sourceValue(editor.scrollDOM)).toBe('$1_x item_2 item_1');
    expect(count()).toBe(label('-empty'));

    // 撤销可恢复全部替换
    const { undo } = await import('@codemirror/commands');
    undo(editor);
    expect(sourceValue(editor.scrollDOM)).toBe('$1_x val_2 val_1');
  });

  it('replaces formatted text in EditableMarkdown preserving inline bold syntax and supports undo', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    await mount({
      ok: true,
      kind: 'markdown',
      content: 'Alpha **beta** and alpha beta.',
      editable: true,
      revision: 'r1',
      url: '/__nomi/preview/replace-md',
    });
    await screen.findByTestId('editable-markdown');

    // 非 macOS Ctrl+H 打开并聚焦替换框
    fireEvent.keyDown(window, {
      key: 'h',
      code: 'KeyH',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const replaceInput = screen.getByTestId('preview-find-replace-input') as HTMLInputElement;
    expect(document.activeElement).toBe(replaceInput);

    fireEvent.change(input(), { target: { value: 'beta' } });
    expect(count()).toBe('1 / 2');
    fireEvent.change(replaceInput, { target: { value: 'gamma' } });
    fireEvent.click(screen.getByTestId('preview-find-replace-one'));

    await waitFor(
      () =>
        expect(resourcePreviewClient.save).toHaveBeenCalledWith(
          '/__nomi/preview/replace-md',
          'r1',
          'Alpha **gamma** and alpha beta.',
        ),
      { timeout: 2000 },
    );
    expect(count()).toBe('1 / 1');

    // 替换剩余全部
    fireEvent.click(screen.getByTestId('preview-find-replace-all'));
    await waitFor(() =>
      expect(screen.getByTestId('editable-markdown').textContent).toBe(
        'Alpha gamma and alpha gamma.',
      ),
    );

    // Mod+Z 撤销恢复上一步状态
    const editableMd = screen.getByTestId('editable-markdown');
    fireEvent.keyDown(editableMd, { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() =>
      expect(screen.getByTestId('editable-markdown').textContent).toBe(
        'Alpha gamma and alpha beta.',
      ),
    );
  });

  it('supports find in FileReview diff mode and find/replace/save in FileReview edit mode', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    vi.mocked(harnessClient.workspaceRead).mockResolvedValue({
      ok: true,
      content: 'const a = "old";\nconst b = "old";\n',
    });
    vi.mocked(resourcePreviewClient.open).mockResolvedValue({
      ok: true,
      editable: true,
      content: 'const a = "old";\nconst b = "old";\n',
      url: 'cap-review',
      revision: 'r1',
    });
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const reviewFile: ReviewFile = {
      key: 'u:src/demo.ts',
      path: 'src/demo.ts',
      gitDiff: {
        file: 'src/demo.ts',
        diff: {
          added: 1,
          removed: 1,
          lines: [
            { type: 'del', text: 'const target = 1;', oldNo: 1 },
            { type: 'add', text: 'const target = 2;', newNo: 1 },
          ],
        },
      },
    };
    render(
      <FileReview
        files={[reviewFile]}
        activeKey="u:src/demo.ts"
        cwd="/w"
        onActiveKey={() => undefined}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    // Diff 模式按 Cmd+F 搜索 diff 内容；不支持替换；Esc 只关搜索不关 FileReview
    key(false, { ctrlKey: false, metaKey: true });
    expect(screen.queryByTestId('preview-find-toggle-replace')).toBeNull();
    fireEvent.change(input(), { target: { value: 'target' } });
    expect(count()).toBe('1 / 2');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // 切到编辑模式：读盘后用工具栏查找按钮打开，展开替换并全部替换再保存
    fireEvent.click(screen.getByTestId('preview-mode-file'));
    const ta = (await screen.findByTestId('preview-editor')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain('"old"'));

    fireEvent.click(screen.getByTestId('preview-find-trigger'));
    fireEvent.click(screen.getByTestId('preview-find-toggle-replace'));
    fireEvent.change(input(), { target: { value: 'old' } });
    expect(count()).toBe('1 / 2');
    fireEvent.change(screen.getByTestId('preview-find-replace-input'), {
      target: { value: 'new' },
    });
    fireEvent.click(screen.getByTestId('preview-find-replace-all'));

    expect(ta.value).toBe('const a = "new";\nconst b = "new";\n');
    fireEvent.click(screen.getByTestId('preview-save'));
    await waitFor(() =>
      expect(resourcePreviewClient.save).toHaveBeenCalledWith(
        'cap-review',
        'r1',
        'const a = "new";\nconst b = "new";\n',
      ),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
