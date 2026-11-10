// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EditableMarkdown } from '../src/components/ResourcePreview/EditableMarkdown';
import { MarkdownDocument } from '../src/components/ResourcePreview/MarkdownDocument';
import {
  parsePreviewMarkdown,
  type MarkdownParseRequest,
} from '../src/components/ResourcePreview/markdownParse';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';

class ParserWorker {
  static instances: ParserWorker[] = [];
  requests: MarkdownParseRequest[] = [];
  onmessage?: (event: unknown) => void;
  onerror?: (event: unknown) => void;
  terminate = vi.fn();
  constructor() {
    ParserWorker.instances.push(this);
  }
  postMessage(request: MarkdownParseRequest) {
    this.requests.push(request);
  }
  respond(index = 0) {
    const request = this.requests[index]!;
    this.onmessage?.({
      data: { id: request.id, tree: parsePreviewMarkdown(request.text, request.editable) },
    });
  }
}
const context = { scope: { id: 'worker-preview', cwd: '/other-workspace' }, open: vi.fn() };
const padding = '\r\n\r\n' + 'padding '.repeat(15_000);
function editor(text: string, onChange = vi.fn()) {
  return render(
    <ResourceScopeProvider value={context}>
      <EditableMarkdown text={text} editable onChange={onChange} />
    </ResourceScopeProvider>,
  );
}
beforeEach(() => {
  ParserWorker.instances = [];
  vi.stubGlobal('Worker', ParserWorker);
});
afterEach(async () => {
  vi.useFakeTimers();
  cleanup();
  await act(async () => {
    vi.advanceTimersByTime(10_001);
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('large Markdown background parsing', () => {
  it('preserves source spelling, reference links, CRLF and table edits after the worker result mounts', async () => {
    const text =
      '# Title\r\n\r\n| A | B |\r\n| --- | --- |\r\n| old | _italic_ and [label][r] |\r\n\r\n[r]: ./next.md\r\n' +
      padding;
    const changed = vi.fn();
    const { container } = editor(text, changed);
    expect(container.querySelector('[data-preview-markdown-pending]')).not.toBeNull();
    expect(ParserWorker.instances).toHaveLength(1);
    await act(async () => {
      ParserWorker.instances[0]!.respond();
    });
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    const cell = container.querySelectorAll('td')[1]!;
    cell.appendChild(document.createTextNode(' appended'));
    fireEvent.input(cell);
    expect(changed).toHaveBeenLastCalledWith(
      text.replace('_italic_ and [label][r]', '_italic_ and [label][r] appended'),
    );
    // No reparse of the original Markdown and no replacement of live editing DOM.
    expect(container.querySelectorAll('td')[1]).toBe(cell);
    expect(ParserWorker.instances[0]!.requests).toHaveLength(1);
  });
  it('reuses the last parsed document across a source/preview round trip and releases it when idle', async () => {
    const text = '# Cached' + padding;
    const first = editor(text);
    const worker = ParserWorker.instances[0]!;
    await act(async () => {
      worker.respond();
    });
    first.unmount();
    editor(text);
    expect(screen.getByRole('heading', { name: 'Cached' })).toBeTruthy();
    expect(worker.requests).toHaveLength(1);
    vi.useFakeTimers();
    cleanup();
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
    const third = editor(text);
    expect(third.container.querySelector('[data-preview-markdown-pending]')).not.toBeNull();
    expect(ParserWorker.instances).toHaveLength(2);
    await act(async () => {
      ParserWorker.instances[1]!.respond();
    });
  });
  it('commits redo and restores its caret before subsequent browser input', async () => {
    editor('# Title' + padding);
    const worker = ParserWorker.instances[0]!;
    await act(async () => {
      worker.respond();
    });
    const heading = screen.getByRole('heading', { name: 'Title' });
    heading.textContent = 'Changed';
    const range = document.createRange();
    range.setStart(heading.firstChild!, 3);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.input(heading);
    const root = screen.getByTestId('editable-markdown');
    fireEvent.keyDown(root, { key: 'z', metaKey: true });
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    fireEvent.keyDown(root, { key: 'z', metaKey: true, shiftKey: true });
    expect(root.querySelector('[data-preview-markdown-pending]')).toBeNull();
    expect(worker.requests).toHaveLength(1);
    const restored = screen.getByRole('heading', { name: 'Changed' });
    expect(restored.contains(window.getSelection()!.anchorNode)).toBe(true);
    expect(window.getSelection()!.anchorOffset).toBe(3);
  });
  it('keeps typing, paste and IME available immediately after a large-document heading demotion', async () => {
    const text = '# Title' + padding;
    const changed = vi.fn();
    editor(text, changed);
    const worker = ParserWorker.instances[0]!;
    await act(async () => {
      worker.respond();
    });
    const root = screen.getByTestId('editable-markdown');
    const heading = screen.getByRole('heading', { name: 'Title' });
    root.focus();
    const range = document.createRange();
    range.setStart(heading.firstChild!, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(root, { key: 'Backspace' });
    expect(root.querySelector('[data-preview-markdown-pending]')).toBeNull();
    expect(worker.requests).toHaveLength(1);
    const typing = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'typed',
    });
    fireEvent(root, typing);
    expect(typing.defaultPrevented).toBe(false);
    const paragraph = root.querySelector('p')!;
    paragraph.firstChild!.textContent = 'typedTitle';
    fireEvent.input(paragraph);
    expect(changed).toHaveBeenLastCalledWith('typedTitle' + padding);
    const next = document.createRange();
    next.selectNodeContents(paragraph);
    next.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(next);
    fireEvent.paste(root, { clipboardData: { getData: () => ' pasted' } });
    expect(changed).toHaveBeenLastCalledWith('typedTitle pasted' + padding);
    fireEvent.compositionStart(paragraph);
    paragraph.appendChild(document.createTextNode('中文'));
    fireEvent.compositionEnd(paragraph);
    expect(changed).toHaveBeenLastCalledWith('typedTitle pasted中文' + padding);
    expect(worker.requests).toHaveLength(1);
  });
  it('does not reclaim chat focus after a structural edit or a later parse completion', async () => {
    const { container } = editor('# Title' + padding);
    const composer = document.createElement('input');
    container.appendChild(composer);
    const worker = ParserWorker.instances[0]!;
    await act(async () => {
      worker.respond();
    });
    const root = screen.getByTestId('editable-markdown');
    root.focus();
    const heading = screen.getByRole('heading', { name: 'Title' });
    const range = document.createRange();
    range.setStart(heading.firstChild!, 0);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(root, { key: 'Backspace' });
    composer.focus();
    await act(async () => {
      worker.respond();
    });
    expect(document.activeElement).toBe(composer);
    expect(worker.requests).toHaveLength(1);
  });
  it('defers saved scroll and fragment navigation until asynchronous headings exist', async () => {
    const onNavigated = vi.fn();
    const { container } = render(
      <MarkdownDocument
        text={'# First\n\n## Target' + padding}
        context={context}
        outline
        onOutlineChange={() => {}}
        scrollTop={350}
        onScroll={() => {}}
        navigation={{ fragment: 'target', sequence: 1 }}
        onNavigated={onNavigated}
      />,
    );
    expect(onNavigated).not.toHaveBeenCalled();
    const viewport = screen.getByTestId('preview-markdown');
    expect(viewport.scrollTop).toBe(0);
    await act(async () => {
      ParserWorker.instances[0]!.respond();
    });
    await waitFor(() => expect(onNavigated).toHaveBeenCalledOnce());
    expect(container.querySelector('#target')).not.toBeNull();
    expect(viewport.scrollTop).toBe(350);
  });
  it('falls back to the existing renderer when workers are unavailable without losing link safety', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    editor('# Fallback\n\n[unsafe](javascript:alert%281%29) &copy;' + padding);
    await act(async () => {
      ParserWorker.instances[0]!.onerror?.({ preventDefault() {} });
    });
    expect(screen.getByRole('heading', { name: 'Fallback' })).toBeTruthy();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.body.textContent).toContain('©');
  });
});
