// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { AppTitleBar } from '../src/components/TitleBar';
import { TitlebarContent, TitlebarPanelsProvider } from '../src/components/TitleBar/panels';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.platform;
});

it('keeps panel controls interactive after moving them into the desktop titlebar', () => {
  document.documentElement.dataset.platform = 'darwin';
  const Counter = () => {
    const [n, setN] = useState(0);
    return (
      <TitlebarContent name="files">
        <button onClick={() => setN(n + 1)}>{n}</button>
      </TitlebarContent>
    );
  };
  const r = render(
    <TitlebarPanelsProvider>
      <div className="ai-chat-app">
        <AppTitleBar sidebarCollapsed={false} filesOpen onToggleSidebar={() => {}} />
        <aside data-testid="files-rail">
          <Counter />
        </aside>
      </div>
    </TitlebarPanelsProvider>,
  );
  const button = r.getByRole('button', { name: '0' });
  expect(button.closest('[data-titlebar-slot="files"]')).toBeTruthy();
  expect(r.getByTestId('files-rail').contains(button)).toBe(false);
  fireEvent.click(button);
  expect(button.textContent).toBe('1');
});

it('recomputes titlebar boundaries from real panel sizes after a resize', () => {
  let resize: (() => void) | undefined;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(fn: () => void) {
        resize = fn;
      }
      observe() {}
      disconnect() {}
    },
  );
  let sidebarWidth = 260;
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement,
  ) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = this.dataset.testid;
    const left =
      id === 'files-rail'
        ? 900
        : id === 'side-workspace'
          ? 650
          : id === 'sidebar-panel'
            ? 52
            : 52 + sidebarWidth;
    const right =
      id === 'sidebar-panel'
        ? 52 + sidebarWidth
        : id === 'chat-column'
          ? 650
          : id === 'side-workspace'
            ? 900
            : 1160;
    return {
      x: left,
      y: 38,
      left,
      right,
      top: 38,
      bottom: 800,
      width: right - left,
      height: 762,
      toJSON: () => ({}),
    };
  });
  const r = render(
    <div className="ai-chat-app">
      <AppTitleBar sidebarCollapsed={false} onToggleSidebar={() => {}} />
      <div data-testid="sidebar-panel" />
      <div data-testid="workspace-card">
        <div data-testid="chat-column" />
        <div data-testid="side-workspace" />
        <aside data-testid="files-rail" />
      </div>
    </div>,
  );
  const bar = r.getByTestId('app-titlebar');
  expect(bar.style.getPropertyValue('--titlebar-main-left')).toBe('312px');
  sidebarWidth = 360;
  act(() => resize?.());
  expect(bar.style.getPropertyValue('--titlebar-main-left')).toBe('412px');
  expect(bar.style.getPropertyValue('--titlebar-files-left')).toBe('900px');
});

it('aligns the title after the lazy settings panel mounts', async () => {
  const r = render(
    <div className="ai-chat-app">
      <AppTitleBar sidebarCollapsed={false} onToggleSidebar={() => {}} />
    </div>,
  );
  const overlay = document.createElement('div');
  overlay.className = 'settings-workspace';
  const settings = document.createElement('div');
  settings.dataset.testid = 'settings-view';
  const main = document.createElement('main');
  const rect = {
    left: 248,
    right: 1200,
    width: 952,
    top: 38,
    bottom: 800,
    height: 762,
    x: 248,
    y: 38,
    toJSON: () => ({}),
  };
  main.getBoundingClientRect = () => rect;
  main.getClientRects = () => [rect] as unknown as DOMRectList;
  settings.append(main);
  overlay.append(settings);
  await act(async () => {
    r.container.querySelector('.ai-chat-app')!.append(overlay);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(r.getByTestId('app-titlebar').style.getPropertyValue('--titlebar-main-left')).toBe(
    '248px',
  );
});

it('keeps session controls above the chat when the files rail opens or closes', () => {
  document.documentElement.dataset.platform = 'darwin';
  const Scene = ({ filesOpen }: { filesOpen: boolean }) => (
    <TitlebarPanelsProvider>
      <div className="ai-chat-app">
        <AppTitleBar sidebarCollapsed={false} filesOpen={filesOpen} onToggleSidebar={() => {}} />
        <TitlebarContent name="session">
          <button>Session controls</button>
        </TitlebarContent>
      </div>
    </TitlebarPanelsProvider>
  );
  const r = render(<Scene filesOpen={false} />);
  for (const filesOpen of [false, true, false]) {
    r.rerender(<Scene filesOpen={filesOpen} />);
    const controls = r.getByRole('button', { name: 'Session controls' });
    expect(controls.closest('.app-titlebar-main')).toBeTruthy();
    expect(controls.closest('.app-titlebar-files')).toBeNull();
  }
});

it('never lets titlebar-main-left cross left of the sidebar/card edge during transient transform animations and re-syncs when settled', () => {
  let chatOffset = -16; // 模拟从全屏回到分栏瞬间的 translate3d(-16px, 0, 0) 偏移
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement,
  ) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = this.dataset.testid;
    const left =
      id === 'sidebar-panel'
        ? 52
        : id === 'workspace-card'
          ? 312
          : id === 'chat-column'
            ? 312 + chatOffset
            : id === 'side-workspace'
              ? 720 + chatOffset
              : 0;
    const right =
      id === 'sidebar-panel'
        ? 312
        : id === 'chat-column'
          ? 720 + chatOffset
          : id === 'side-workspace'
            ? 1200
            : 1200;
    return {
      x: left,
      y: 38,
      left,
      right,
      top: 38,
      bottom: 800,
      width: right - left,
      height: 762,
      toJSON: () => ({}),
    };
  });

  const r = render(
    <div className="ai-chat-app">
      <AppTitleBar sidebarCollapsed={false} centerOpen onToggleSidebar={() => {}} />
      <div data-testid="sidebar-panel" />
      <div data-testid="workspace-card">
        <div data-testid="chat-column" />
        <div data-testid="side-workspace" />
      </div>
    </div>,
  );

  const bar = r.getByTestId('app-titlebar');
  // 即使动画首帧 chat-column 有 -16px 负偏移，标题左边界也严格对齐卡片/侧栏边缘 312px，绝不向左越界
  expect(bar.style.getPropertyValue('--titlebar-main-left')).toBe('312px');
  expect(bar.style.getPropertyValue('--titlebar-center-left')).toBe('704px');

  // 动画结束清掉 transform 并派发 nomi:layout-settled，无需拖动下方分割线即可自动精准归位到 720px
  chatOffset = 0;
  act(() => {
    window.dispatchEvent(new Event('nomi:layout-settled'));
  });
  expect(bar.style.getPropertyValue('--titlebar-main-left')).toBe('312px');
  expect(bar.style.getPropertyValue('--titlebar-center-left')).toBe('720px');
});
