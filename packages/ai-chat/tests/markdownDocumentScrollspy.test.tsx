// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownDocument } from '../src/components/ResourcePreview/MarkdownDocument';

const rect = (top: number, height = 24) =>
  ({
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(scrollTop = 0, editable = false) {
  let resize: ResizeObserverCallback = () => {};
  let mutated: MutationCallback = () => {};
  const disconnected = vi.fn();
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: MutationCallback) {
        mutated = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const offsets = [16, 500, 900];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute('data-resource-document')) return rect(100, 400);
    if (/^H[1-6]$/.test(this.tagName)) {
      const i = ['First', 'Second', 'Last'].indexOf(
        (this.textContent ?? '').replace('Renamed', 'Second'),
      );
      return rect(100 + offsets[i]! - (this.closest('[data-resource-document]')?.scrollTop ?? 0));
    }
    return rect(0);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1400);
  const onScroll = vi.fn(),
    onChange = vi.fn();
  render(
    <MarkdownDocument
      text={'# First\n\nbody\n\n## Second\n\nbody\n\n## Last\n\nbody'}
      context={{ scope: { id: 'a', cwd: '/w' }, open: vi.fn() }}
      outline
      onOutlineChange={vi.fn()}
      scrollTop={scrollTop}
      onScroll={onScroll}
      editable={editable}
      onChange={onChange}
    />,
  );
  const body = screen.getByTestId('preview-markdown');
  const flush = () =>
    act(() => {
      frames.splice(0).forEach((callback) => callback(0));
    });
  const scroll = (top: number) => {
    body.scrollTop = top;
    fireEvent.scroll(body);
    flush();
  };
  const active = () =>
    screen.getByTestId('preview-outline').querySelector('[aria-current="location"]')?.textContent;
  return {
    body,
    active,
    scroll,
    flush,
    offsets,
    resize: () => {
      act(() => resize([], {} as ResizeObserver));
      flush();
    },
    onScroll,
    disconnected,
    mutated: () => {
      act(() => mutated([], {} as MutationObserver));
      flush();
    },
  };
}
describe('document scroll-linked outline', () => {
  it('marks the first chapter immediately and honors restored scroll position', () => {
    const first = setup();
    expect(first.active()).toBe('First');
    cleanup();
    vi.restoreAllMocks();
    const restored = setup(550);
    expect(restored.active()).toBe('Second');
  });
  it('tracks down/up scrolling, long sections, start and the document bottom', () => {
    const p = setup();
    p.scroll(550);
    expect(p.active()).toBe('Second');
    p.scroll(750);
    expect(p.active()).toBe('Second');
    p.scroll(0);
    expect(p.active()).toBe('First');
    p.offsets[2] = 1350;
    p.scroll(1000);
    expect(p.active()).toBe('Last');
    expect(p.onScroll).toHaveBeenLastCalledWith(1000, undefined);
  });
  it('recomputes after images/diagrams resize without needing another scroll', () => {
    const p = setup(550);
    expect(p.active()).toBe('Second');
    p.offsets[1] = 800;
    p.resize();
    expect(p.active()).toBe('First');
  });
  it('updates edited heading labels and anchors without resetting scroll, and disconnects on unmount', () => {
    const p = setup(550, true);
    const heading = screen.getByRole('heading', { name: 'Second' });
    heading.textContent = 'Renamed';
    p.mutated();
    expect(p.active()).toBe('Renamed');
    expect(heading.id).toBe('renamed');
    expect(p.body.scrollTop).toBe(550);
    cleanup();
    expect(p.disconnected).toHaveBeenCalled();
  });
  it('clicking an outline item scrolls only the document to that heading', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    expect(p.body.scrollTop).toBeGreaterThanOrEqual(480);
    expect(p.active()).toBe('Second');
    p.scroll(0);
    expect(p.active()).toBe('First');
  });
  it('scroll-linked highlighting does not move the editable caret or keyboard focus', () => {
    const p = setup(0, true);
    const heading = screen.getByRole('heading', { name: 'First' });
    heading.focus();
    const range = document.createRange();
    range.selectNodeContents(heading);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    p.scroll(550);
    expect(p.active()).toBe('Second');
    expect(document.activeElement).toBe(heading);
    expect(window.getSelection()?.anchorNode).toBe(heading);
  });
});
