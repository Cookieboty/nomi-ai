// @vitest-environment happy-dom
import { Tabs, SegmentedControl } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenFileTab } from '../src/components/SideWorkspace/OpenFileTab';
import {
  scrollTabIntoStrip,
  useDirectionalTabMotion,
  useTabStripFlip,
  useWorkspaceLayoutMotion,
} from '../src/hooks/useTabMotion';

function mockMotionPreference(allowed: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('no-preference') ? allowed : !allowed,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Tabs & workspace fullscreen motion', () => {
  it('settles sliding indicator immediately on first mount and animates on subsequent tab changes', () => {
    const offsets: Record<string, { left: number; width: number; height: number }> = {
      a: { left: 4, width: 64, height: 28 },
      b: { left: 72, width: 88, height: 28 },
    };
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const key = this.getAttribute('data-testid') ?? this.getAttribute('data-value') ?? '';
      return offsets[key]?.left ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const key = this.getAttribute('data-testid') ?? this.getAttribute('data-value') ?? '';
      return offsets[key]?.width ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const key = this.getAttribute('data-testid') ?? this.getAttribute('data-value') ?? '';
      return offsets[key]?.height ?? 0;
    });

    function Demo() {
      const [tab, setTab] = useState<'a' | 'b'>('a');
      const [seg, setSeg] = useState<'a' | 'b'>('a');
      return (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'a', label: 'Tab A', testId: 'a' },
              { value: 'b', label: 'Tab B', testId: 'b' },
            ]}
          />
          <SegmentedControl
            aria-label="mode"
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'a', label: 'Seg A' },
              { value: 'b', label: 'Seg B' },
            ]}
          />
        </>
      );
    }

    const { container } = render(<Demo />);
    const tablist = screen.getByRole('tablist');
    const indicator = tablist.querySelector<HTMLElement>('.cd-tabs__indicator')!;
    expect(tablist.getAttribute('data-sliding')).toBe('true');
    // 首次就位不播动画，防止从 x=0 闪入
    expect(indicator.hasAttribute('data-animate')).toBe(false);
    expect(indicator.style.width).toBe('64px');
    expect(indicator.style.transform).toContain('translate3d(4px, 0px, 0)');

    // 切换到第二个标签：启用平滑横移并更新目标宽度与位移
    fireEvent.click(screen.getByTestId('b'));
    expect(indicator.getAttribute('data-animate')).toBe('true');
    expect(indicator.style.width).toBe('88px');
    expect(indicator.style.transform).toContain('translate3d(72px, 0px, 0)');

    // SegmentedControl 同样驱动滑块横移
    fireEvent.click(screen.getByRole('radio', { name: 'Seg B' }));
    const segIndicator = container.querySelectorAll<HTMLElement>('.cd-tabs__indicator')[1]!;
    expect(segIndicator.getAttribute('data-animate')).toBe('true');
    expect(segIndicator.style.width).toBe('88px');
  });

  it('computes directional parity tokens so consecutive same-direction switches retrigger CSS animation', () => {
    const keys = ['t1', 't2', 't3'];
    function Probe({ active }: { active: string }) {
      const motion = useDirectionalTabMotion(keys, active);
      return <div data-testid="probe" data-motion={motion ?? ''} />;
    }

    const { rerender } = render(<Probe active="t1" />);
    expect(screen.getByTestId('probe').dataset.motion).toBe('');

    rerender(<Probe active="t2" />);
    expect(screen.getByTestId('probe').dataset.motion).toBe('right-b');

    rerender(<Probe active="t3" />);
    expect(screen.getByTestId('probe').dataset.motion).toBe('right-a');

    rerender(<Probe active="t1" />);
    expect(screen.getByTestId('probe').dataset.motion).toBe('left-b');
  });

  it('marks newly opened tabs as entering and runs FLIP compensation when neighbors shift', () => {
    vi.useFakeTimers();
    mockMotionPreference(true);
    let positions: Record<string, number> = { k1: 0, k2: 120 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const k = this.getAttribute('data-tab-key') ?? '';
      const left = positions[k] ?? 0;
      return {
        left,
        top: 0,
        right: left + 110,
        bottom: 32,
        width: 110,
        height: 32,
        x: left,
        y: 0,
        toJSON: () => ({}),
      };
    });

    function Strip({ items }: { items: string[] }) {
      const ref = useRef<HTMLDivElement>(null);
      useTabStripFlip(ref, items, 'data-tab-key');
      return (
        <div ref={ref}>
          {items.map((k) => (
            <div key={k} data-testid={`tab-${k}`} data-tab-key={k}>
              {k}
            </div>
          ))}
        </div>
      );
    }

    const { rerender } = render(<Strip items={['k1', 'k2']} />);
    expect(screen.getByTestId('tab-k1').dataset.tabEntering).toBeUndefined();

    // 新增 k3：标记 data-tab-entering="true"，动画结束后自动清除
    positions = { k1: 0, k2: 120, k3: 240 };
    rerender(<Strip items={['k1', 'k2', 'k3']} />);
    expect(screen.getByTestId('tab-k3').dataset.tabEntering).toBe('true');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId('tab-k3').dataset.tabEntering).toBeUndefined();

    // 关闭中间的 k2，k3 从 240 移到 120：触发 FLIP 平滑位移并在结束后清空内联样式
    positions = { k1: 0, k3: 120 };
    rerender(<Strip items={['k1', 'k3']} />);
    expect(screen.getByTestId('tab-k3').style.transition).toContain('transform');
    act(() => {
      vi.advanceTimersByTime(230);
    });
    expect(screen.getByTestId('tab-k3').style.transition).toBe('');
    expect(screen.getByTestId('tab-k3').style.transform).toBe('');
  });

  it('animates workspace fullscreen transitions and cleans up inline transforms afterwards', () => {
    vi.useFakeTimers();
    mockMotionPreference(true);

    function LayoutHarness({
      maximized,
      split,
      open,
    }: {
      maximized: boolean;
      split: boolean;
      open: boolean;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      useWorkspaceLayoutMotion({ mainRef: ref, maximized, split, open });
      return (
        <div ref={ref} data-testid="main">
          {maximized && <div data-testid="side-tab-strip" />}
          <div data-testid="chat-column" hidden={maximized && !split} />
          <section data-testid="side-workspace" />
        </div>
      );
    }

    const { rerender } = render(<LayoutHarness maximized={false} split={false} open />);
    const workspace = screen.getByTestId('side-workspace');
    expect(workspace.style.transition).toBe('');

    // 分栏 → 双击铺满全屏：启动平滑空间过渡，260ms 后清除 transform（不污染内部 fixed 菜单定位）
    rerender(<LayoutHarness maximized split={false} open />);
    expect(workspace.style.transition).toContain('transform');
    expect(screen.getByTestId('side-tab-strip').style.transition).toContain('transform');
    act(() => {
      vi.advanceTimersByTime(270);
    });
    expect(workspace.style.transition).toBe('');
    expect(workspace.style.transform).toBe('');
    expect(workspace.style.transformOrigin).toBe('');

    // 全屏铺满 → 回到分栏：主对话列与右侧工作区同步过渡归位
    rerender(<LayoutHarness maximized={false} split={false} open />);
    expect(screen.getByTestId('chat-column').style.transition).toContain('transform');
    expect(workspace.style.transition).toContain('transform');
    act(() => {
      vi.advanceTimersByTime(270);
    });
    expect(screen.getByTestId('chat-column').style.transform).toBe('');
  });

  it('plays slide-out exit animation before hiding the workspace file tree when motion is enabled', () => {
    vi.useFakeTimers();
    mockMotionPreference(true);

    const controlRef = { current: null };
    const { rerender } = render(
      <OpenFileTab
        messages={[]}
        cwd="/repo"
        renderPreview={() => <div data-testid="fake-preview" />}
        expanded={false}
        onExpanded={vi.fn()}
        controlRef={controlRef}
        railSplit={{ width: 260, onPointerDown: vi.fn(), onDoubleClick: vi.fn() }}
        treeOpen
        onToggleTree={vi.fn()}
      />,
    );

    const tree = screen.getByTestId('open-file-tree');
    expect(tree.hidden).toBe(false);
    expect(tree.dataset.closing).toBeUndefined();

    rerender(
      <OpenFileTab
        messages={[]}
        cwd="/repo"
        renderPreview={() => <div data-testid="fake-preview" />}
        expanded={false}
        onExpanded={vi.fn()}
        controlRef={controlRef}
        railSplit={{ width: 260, onPointerDown: vi.fn(), onDoubleClick: vi.fn() }}
        treeOpen={false}
        onToggleTree={vi.fn()}
      />,
    );

    // 退场期间保持可见并挂上 data-closing 播放滑出推拉动画
    expect(tree.hidden).toBe(false);
    expect(tree.dataset.closing).toBe('true');

    // 动画结束后完成隐藏
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(tree.hidden).toBe(true);
    expect(tree.dataset.closing).toBeUndefined();
  });

  it('scrolls newly opened tabs inside the tab strip only without shifting outer app containers', () => {
    mockMotionPreference(true);
    const outerApp = document.createElement('div');
    const strip = document.createElement('div');
    const newTab = document.createElement('div');
    strip.appendChild(newTab);
    outerApp.appendChild(strip);
    document.body.appendChild(outerApp);

    Object.defineProperty(strip, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(strip, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(newTab, 'offsetLeft', { value: 760, configurable: true });
    Object.defineProperty(newTab, 'offsetWidth', { value: 110, configurable: true });

    const scrollToSpy = vi.fn(({ left }: { left: number }) => {
      strip.scrollLeft = left;
    });
    strip.scrollTo = scrollToSpy as unknown as typeof strip.scrollTo;

    scrollTabIntoStrip(strip, newTab, true);

    expect(scrollToSpy).toHaveBeenCalledWith({
      left: 760 + 110 - 300 + 16,
      behavior: 'smooth',
    });
    // 外层主容器 scrollLeft 保持 0，绝不把左侧会话栏滚出视口
    expect(outerApp.scrollLeft).toBe(0);
    outerApp.remove();
  });

  it('slides side workspace in and out with width-conserving margin push-pull', () => {
    vi.useFakeTimers();
    mockMotionPreference(true);

    function SlideHarness({ open, closing }: { open: boolean; closing: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useWorkspaceLayoutMotion({
        mainRef: ref,
        maximized: false,
        split: false,
        open,
        closing,
        chatWidth: 500,
      });
      return (
        <div ref={ref} data-testid="main">
          <div data-testid="chat-column" />
          {(open || closing) && <section data-testid="side-workspace" />}
        </div>
      );
    }

    const { rerender } = render(<SlideHarness open={false} closing={false} />);
    const main = screen.getByTestId('main');
    Object.defineProperty(main, 'clientWidth', { value: 1005, configurable: true });

    // 展开工作区：用负右边距推拉进场，完成后清空临时内联宽度
    rerender(<SlideHarness open closing={false} />);
    const ws = screen.getByTestId('side-workspace');
    expect(ws.style.transition).toContain('margin-inline-end');
    expect(ws.style.marginInlineEnd).toBe('0px');
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(ws.style.width).toBe('');
    expect(ws.style.transition).toBe('');

    // 收起工作区：推拉滑向负右边距
    rerender(<SlideHarness open={false} closing />);
    expect(ws.style.transition).toContain('margin-inline-end');
    expect(ws.style.marginInlineEnd).toMatch(/^-\d+px$/);
  });
});
