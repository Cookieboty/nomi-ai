// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePreviewSelectionMenu } from '../src/components/ResourcePreview/PreviewSelectionMenu';
import {
  ChangesUiProvider,
  useChangesUi,
} from '../src/components/SessionWorkspace/ChangesUiContext';
import { SelectionActionsContext } from '../src/contexts/SelectionActionsContext';

const highlightKey = 'preview-context-selection';
let highlights: Map<string, unknown>;
const writeText = vi.fn(async (_text: string) => undefined);
function Document({ source = false }: { source?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const { composerFill } = useChangesUi();
  const menu = usePreviewSelectionMenu({
    root,
    fileKey: 'document',
    path: '/work/design.md',
    text: 'left | right',
    enabled: true,
    canAsk: true,
  });
  return (
    <>
      <div ref={root} onContextMenu={menu.onContextMenu}>
        {source ? (
          <textarea aria-label="source" data-preview-find-content defaultValue="left | right" />
        ) : (
          <div data-preview-find-content data-resource-document>
            <table>
              <tbody>
                <tr>
                  <td data-preview-line-start="7" data-preview-line-end="7">
                    left
                  </td>
                  <td data-preview-line-start="7" data-preview-line-end="7">
                    right
                  </td>
                </tr>
              </tbody>
            </table>
            <p>other content</p>
          </div>
        )}
      </div>
      <textarea aria-label="other input" defaultValue="unrelated text" />
      <output>{composerFill?.text}</output>
      {menu.menu}
    </>
  );
}
function mount(source = false) {
  render(
    <ChangesUiProvider>
      <Document source={source} />
    </ChangesUiProvider>,
  );
}
function selectTable() {
  const cells = screen.getAllByRole('cell');
  const range = document.createRange();
  range.setStart(cells[0]!.firstChild!, 0);
  range.setEnd(cells[1]!.firstChild!, 5);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  return cells[0]!;
}
function expectCleared() {
  expect(window.getSelection()!.isCollapsed).toBe(true);
  expect(highlights.has(highlightKey)).toBe(false);
}
beforeEach(() => {
  highlights = new Map();
  vi.stubGlobal('CSS', { highlights });
  vi.stubGlobal('Highlight', class {});
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writeText.mockClear();
});
describe('preview selection dismissal', () => {
  it('in the main window offers add-to-chat and ask-in-side-chat with the file line range', () => {
    const askInSideChat = vi.fn();
    render(
      <SelectionActionsContext.Provider value={{ addToChat: vi.fn(), askInSideChat }}>
        <ChangesUiProvider>
          <Document />
        </ChangesUiProvider>
      </SelectionActionsContext.Provider>,
    );
    fireEvent.contextMenu(selectTable());
    expect(screen.getByTestId('preview-selection-ask').textContent).toBe('添加到对话');
    fireEvent.click(screen.getByTestId('preview-selection-side-chat'));
    expect(askInSideChat).toHaveBeenCalledWith({
      text: expect.stringContaining('left'),
      source: 'design.md:7-7',
    });
    expectCleared();
  });
  it('keeps the table selection while the menu is open and clears it after copying its snapshot', async () => {
    mount();
    fireEvent.contextMenu(selectTable());
    expect(highlights.has(highlightKey)).toBe(true);
    const captured = window.getSelection()!.toString();
    fireEvent.click(screen.getAllByRole('menuitem')[0]!);
    expectCleared();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(writeText).toHaveBeenCalledWith(captured);
    expectCleared();
  });
  it('clears the table selection after asking and retains its source-line reference', () => {
    mount();
    fireEvent.contextMenu(selectTable());
    fireEvent.click(screen.getByTestId('preview-selection-ask'));
    expectCleared();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('[design.md:7-7](/work/design.md:7-7)\n\n');
  });
  it.each([true, false])(
    'clears the old selection on a left click elsewhere (menu open: %s)',
    (open) => {
      mount();
      const cell = selectTable();
      if (open) fireEvent.contextMenu(cell);
      fireEvent.pointerDown(screen.getByText('other content'), { button: 0 });
      expectCleared();
      expect(screen.queryByRole('menu')).toBeNull();
    },
  );
  it.each(['copy', 'ask', 'outside'])(
    'collapses the source textarea selection after %s',
    async (action) => {
      mount(true);
      const input = screen.getByRole('textbox', { name: 'source' }) as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(0, 6);
      fireEvent.contextMenu(input);
      if (action === 'outside')
        fireEvent.pointerDown(screen.getByRole('textbox', { name: 'other input' }), { button: 0 });
      else fireEvent.click(screen.getAllByRole('menuitem')[action === 'copy' ? 0 : 1]!);
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(input.selectionStart).toBe(input.selectionEnd);
      expectCleared();
    },
  );
  it('leaves selections from other inputs alone', () => {
    mount();
    const input = screen.getByRole('textbox', { name: 'other input' }) as HTMLTextAreaElement;
    input.setSelectionRange(0, 5);
    fireEvent.pointerDown(screen.getByText('other content'), { button: 0 });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });
});
