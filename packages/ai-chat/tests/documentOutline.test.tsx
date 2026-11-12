// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentOutline } from '../src/components/ResourcePreview/DocumentOutline';
const label = '3.2 Relay：同样安全输出，写入模型日志，必须保留完整标题但只显示一行';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Probe() {
  const [open, setOpen] = useState(true),
    [width, setWidth] = useState(256);
  return (
    <div style={{ width: 1000 }}>
      <DocumentOutline
        headings={[{ id: 'a', level: 2, text: label }]}
        active="a"
        open={open}
        onOpen={setOpen}
        width={width}
        onWidth={setWidth}
        onPick={vi.fn()}
      />
    </div>
  );
}
function setup() {
  render(<Probe />);
  const pane = screen.getByTestId('preview-outline-pane');
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 356,
    top: 0,
    bottom: 800,
    width: 256,
    height: 800,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  });
  return pane;
}
describe('Reversible, resizable document outline', () => {
  it('uses collapse/expand icons, not a close X; keeps the rail available and restores width', () => {
    const pane = setup();
    expect(screen.getByTestId('preview-outline-toggle').textContent).not.toContain('×');
    expect(screen.getByRole('button', { name: label }).textContent).toBe(label);
    expect(screen.getByRole('button', { name: label }).getAttribute('title')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('preview-outline-splitter'), { key: 'ArrowRight' });
    expect(pane.style.width).toBe('288px');
    fireEvent.click(screen.getByTestId('preview-outline-toggle'));
    expect(screen.queryByTestId('preview-outline')).toBeNull();
    expect(pane.dataset.collapsed).toBe('true');
    fireEvent.click(screen.getByTestId('preview-outline-toggle'));
    expect(screen.getByTestId('preview-outline')).toBeTruthy();
    expect(pane.style.width).toBe('288px');
  });
  it('drags wider, snaps left into a small rail, and drags right to expand again', () => {
    const pane = setup(),
      handle = screen.getByTestId('preview-outline-splitter');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 356 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 480 });
    expect(pane.style.width).toBe('380px');
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150 });
    expect(pane.dataset.collapsed).toBe('true');
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400 });
    expect(pane.style.width).toBe('300px');
    expect(screen.getByTestId('preview-outline')).toBeTruthy();
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 550 });
    expect(pane.style.width).toBe('300px');
  });
  it('cancels a drag without losing the old width, and Home/End are reversible', () => {
    const pane = setup(),
      handle = screen.getByTestId('preview-outline-splitter');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150 });
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(pane.style.width).toBe('256px');
    expect(screen.getByTestId('preview-outline')).toBeTruthy();
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(pane.dataset.collapsed).toBe('true');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(pane.style.width).toBe('480px');
  });
});

describe('outline keeps the current chapter visible without stealing focus', () => {
  it('only scrolls the outline when its active item is clipped, including after reopening', () => {
    const headings = [
      { id: 'a', level: 1, text: 'First' },
      { id: 'b', level: 2, text: 'Second' },
    ];
    const props = { headings, active: 'a', open: true, onOpen: vi.fn(), onPick: vi.fn() };
    const view = render(<DocumentOutline {...props} />);
    const nav = screen.getByTestId('preview-outline');
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    const bounds = (top: number, bottom: number) => ({ top, bottom }) as DOMRect;
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue(bounds(100, 400));
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(bounds(450, 480));
    first.focus();
    view.rerender(<DocumentOutline {...props} active="b" />);
    expect(nav.scrollTop).toBe(80);
    expect(document.activeElement).toBe(first);
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(bounds(70, 100));
    view.rerender(<DocumentOutline {...props} active="a" />);
    expect(nav.scrollTop).toBe(50);
    vi.mocked(second.getBoundingClientRect).mockReturnValue(bounds(200, 230));
    view.rerender(<DocumentOutline {...props} active="b" />);
    expect(nav.scrollTop).toBe(50);
    view.rerender(<DocumentOutline {...props} active="b" open={false} />);
    view.rerender(<DocumentOutline {...props} active="b" />);
    expect(screen.getByRole('button', { name: 'Second' }).getAttribute('aria-current')).toBe(
      'location',
    );
  });
});
