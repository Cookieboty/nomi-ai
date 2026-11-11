// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSidebarResize } from '../src/components/Sidebar/useSidebarResize';
import { clampSidebarWidth, readSidebarWidth, SIDEBAR_WIDTH_KEY } from '../src/utils/sidebarWidth';

vi.mock('@nomi-ai/ui', () => ({ t: (key: string) => key }));

function Probe({ enabled = true }: { enabled?: boolean }) {
  const { width, splitter } = useSidebarResize(enabled);
  return (
    <div data-testid="width" data-width={width}>
      {splitter}
    </div>
  );
}
const width = () => Number(screen.getByTestId('width').getAttribute('data-width'));
const handle = () => screen.getByRole('separator');
const start = () => fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 312 });
const move = (clientX: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('left sidebar resize', () => {
  it('defaults to 260px, clamps persisted values and tolerates corrupt storage', () => {
    expect(readSidebarWidth()).toBe(260);
    for (const [saved, expected] of [
      ['', 260],
      ['bad', 260],
      ['999', 420],
      ['100', 200],
    ] as const) {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, saved);
      expect(readSidebarWidth()).toBe(expected);
    }
    expect(clampSidebarWidth(NaN)).toBe(260);
  });

  it('drags and clamps both directions, persists only when released, then stops moving', () => {
    render(<Probe />);
    start();
    expect(document.body.style.cursor).toBe('col-resize');
    move(1000);
    expect(width()).toBe(420);
    move(0);
    expect(width()).toBe(200);
    move(352);
    expect(width()).toBe(300);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('300');
    expect(document.body.style.cursor).toBe('');
    move(500);
    expect(width()).toBe(300);
  });

  it.each(['escape', 'blur', 'pointercancel'])(
    'cancels on %s and restores original cursor/width',
    (event) => {
      document.body.style.cursor = 'crosshair';
      document.body.style.userSelect = 'text';
      render(<Probe />);
      start();
      move(380);
      if (event === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      else fireEvent(window, new Event(event));
      expect(width()).toBe(260);
      expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
      expect(document.body.style.cursor).toBe('crosshair');
      expect(document.body.style.userSelect).toBe('text');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
  );

  it('cancels if pointer capture is lost', () => {
    render(<Probe />);
    start();
    move(400);
    fireEvent.lostPointerCapture(handle(), { pointerId: 1 });
    expect(width()).toBe(260);
    expect(document.body.style.cursor).toBe('');
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
  });

  it('cleans up a drag on collapse and unmount, hides the handle while collapsed', () => {
    const view = render(<Probe />);
    start();
    move(400);
    view.rerender(<Probe enabled={false} />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(width()).toBe(260);
    expect(document.body.style.cursor).toBe('');
    view.rerender(<Probe />);
    start();
    view.unmount();
    expect(document.body.style.cursor).toBe('');
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();
  });

  it('supports keyboard bounds and double-click reset, ignores secondary buttons', () => {
    render(<Probe />);
    fireEvent.pointerDown(handle(), { button: 2, pointerId: 1, clientX: 312 });
    move(500);
    expect(width()).toBe(260);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(width()).toBe(270);
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(width()).toBe(420);
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(width()).toBe(200);
    fireEvent.doubleClick(handle());
    expect(width()).toBe(260);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('260');
  });
});

describe('会话面板宽度接到窄窗口封顶', () => {
  it('拖的宽度写到根元素的 --sidebar-panel-w-user，面板用 App.css 封顶后的 --sidebar-panel-w', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(
      resolve(__dirname, '../src/components/Sidebar/index.module.css'),
      'utf8',
    );
    expect(css).toMatch(/\.panel\s*\{[^}]*width:\s*var\(--sidebar-panel-w, 260px\)/);
    render(<Probe />);
    const root = () => document.documentElement.style.getPropertyValue('--sidebar-panel-w-user');
    expect(root()).toBe('260px');
    start();
    move(352);
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(root()).toBe('300px');
    cleanup();
    expect(root()).toBe('');
    const app = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
    expect(app).toMatch(/--sidebar-panel-w:\s*min\(var\(--sidebar-panel-w-user/);
  });
});
