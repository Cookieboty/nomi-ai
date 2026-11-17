// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StartupBrandIntro } from '../src/components/BrandIntro';
import {
  FONTS_READY_TIMEOUT_MS,
  LAYOUT_FRAME_FALLBACK_MS,
  StartupReady,
} from '../src/components/BrandIntro/StartupReady';
import {
  introActive,
  STARTUP_HARD_TIMEOUT_MS,
  STARTUP_TASK_TIMEOUT_MS,
  startupBrandIntro,
} from '../src/components/BrandIntro/state';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { Onboarding } from '../src/components/Onboarding';

const WRITE_AND_HOLD_MS = 1400 + 450;

beforeEach(() => {
  startupBrandIntro.resetForTest();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  startupBrandIntro.resetForTest();
});

describe('startup brand introduction', () => {
  it('does not run for a normal launch or a reopened guide', () => {
    render(<StartupBrandIntro />);
    expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
    startupBrandIntro.cancel();
    startupBrandIntro.start();
    expect(startupBrandIntro.getSnapshot().phase).toBe('done');
  });

  it('finishes drawing once, waits for the actual target, then docks', () => {
    startupBrandIntro.start();
    startupBrandIntro.drawn();
    expect(startupBrandIntro.getSnapshot().phase).toBe('waiting');
    const target = document.createElement('span');
    startupBrandIntro.setTarget(target);
    expect(startupBrandIntro.getSnapshot().phase).toBe('docking');
    startupBrandIntro.reveal();
    expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
    startupBrandIntro.complete();
    expect(introActive(startupBrandIntro.getSnapshot().phase)).toBe(false);
    startupBrandIntro.start();
    expect(startupBrandIntro.getSnapshot().phase).toBe('done');
  });

  it('does not dock an early target before the drawing finishes', () => {
    startupBrandIntro.start();
    startupBrandIntro.setTarget(document.createElement('span'));
    expect(startupBrandIntro.getSnapshot().phase).toBe('drawing');
    startupBrandIntro.drawn();
    expect(startupBrandIntro.getSnapshot().phase).toBe('docking');
  });

  it('skipping while loading still waits for the page instead of revealing an empty window', () => {
    startupBrandIntro.start();
    startupBrandIntro.skip();
    expect(startupBrandIntro.getSnapshot()).toMatchObject({ phase: 'waiting', skipped: true });
    startupBrandIntro.setTarget(document.createElement('span'));
    expect(startupBrandIntro.getSnapshot().phase).toBe('done');
  });

  it('respects reduced motion before mounting any animation', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    startupBrandIntro.start();
    render(<StartupBrandIntro />);
    expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
  });

  it('exposes the existing app error screen immediately if rendering fails', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const BrokenApp = (): React.ReactNode => {
      throw new Error('render failed');
    };
    startupBrandIntro.start();
    render(
      <>
        <ErrorBoundary>
          <BrokenApp />
        </ErrorBoundary>
        <StartupBrandIntro />
      </>,
    );
    expect(startupBrandIntro.getSnapshot().phase).toBe('done');
    expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('keeps the same intro through progress updates and shows real import progress', async () => {
    startupBrandIntro.start();
    const r = render(
      <React.StrictMode>
        <StartupBrandIntro bootState={{ kind: 'loading' }} />
      </React.StrictMode>,
    );
    const intro = screen.getByTestId('startup-brand-intro');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1850);
    });
    expect(startupBrandIntro.getSnapshot().phase).toBe('waiting');
    r.rerender(
      <React.StrictMode>
        <StartupBrandIntro bootState={{ kind: 'migrating', done: 3, total: 10 }} />
      </React.StrictMode>,
    );
    expect(screen.getByTestId('startup-brand-intro')).toBe(intro);
    expect(screen.getByRole('status').textContent).toContain('3');
    expect(screen.getByRole('status').textContent).toContain('10');
    act(() => startupBrandIntro.cancel());
    expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
  });

  it('skips only the animation, preserving the guide and its completion behavior', () => {
    const done = vi.fn();
    startupBrandIntro.start();
    render(
      <>
        <Onboarding onDone={done} />
        <StartupBrandIntro />
      </>,
    );
    expect(screen.queryByTestId('onboarding-step-welcome')).toBeNull();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
    expect(screen.getByTestId('onboarding-step-welcome')).toBeTruthy();
    expect(document.activeElement?.id).toBe('onb-title');
    expect(done).not.toHaveBeenCalled();
  });

  it('starts the original guide entrance near the end of docking and transfers focus after landing', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    let land!: () => void;
    const finished = new Promise<void>((resolve) => {
      land = resolve;
    });
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ finished, cancel }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(62);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 13,
      left: 24,
      top: 13,
      right: 86,
      bottom: 33,
      width: 62,
      height: 20,
      toJSON: () => ({}),
    });
    try {
      startupBrandIntro.start();
      render(
        <>
          <Onboarding onDone={vi.fn()} />
          <StartupBrandIntro />
        </>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1400);
      });
      // 完整品牌应停留 450ms，不能绘制刚结束就立刻归位。
      expect(startupBrandIntro.getSnapshot().phase).toBe('drawing');
      expect(animate).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(449);
      });
      expect(animate).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(animate).toHaveBeenCalled();
      expect(startupBrandIntro.getSnapshot().phase).toBe('docking');
      expect(screen.queryByTestId('onboarding-step-welcome')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
      expect(screen.getByTestId('onboarding-step-welcome')).toBeTruthy();
      await act(async () => {
        land();
        await finished;
      });
      expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
      expect(document.activeElement?.id).toBe('onb-title');
      expect(cancel).toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'animate', descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });
});

describe('returning-user startup', () => {
  it('keeps the screen covered after drawing until all startup data and layout are ready', () => {
    startupBrandIntro.start('app');
    startupBrandIntro.drawn();
    expect(startupBrandIntro.getSnapshot().phase).toBe('waiting');
    for (const task of ['nomi', 'tabs', 'sidebar'] as const) startupBrandIntro.taskDone(task);
    expect(startupBrandIntro.getSnapshot().pending).toEqual([]);
    expect(startupBrandIntro.getSnapshot().phase).toBe('waiting');
    startupBrandIntro.appReady();
    expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
  });

  it('skip closes the cover immediately even while startup data is still loading', () => {
    startupBrandIntro.start('app');
    startupBrandIntro.drawn();
    expect(startupBrandIntro.getSnapshot().phase).toBe('waiting');
    startupBrandIntro.skip();
    expect(startupBrandIntro.getSnapshot().phase).toBe('done');
    // 数据随后到达也不会把开屏拉回来
    startupBrandIntro.taskStart('nomi');
    startupBrandIntro.appReady();
    expect(startupBrandIntro.getSnapshot().phase).toBe('done');
  });

  it('clicking the skip button while waiting removes the cover', () => {
    startupBrandIntro.start('app');
    render(<StartupBrandIntro />);
    act(() => startupBrandIntro.drawn());
    expect(screen.getByTestId('startup-brand-intro').dataset.phase).toBe('waiting');
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
  });

  it('a startup task that never finishes is given up on after its own timeout', () => {
    startupBrandIntro.start('app');
    startupBrandIntro.taskDone('tabs');
    startupBrandIntro.taskDone('sidebar');
    act(() => vi.advanceTimersByTime(STARTUP_TASK_TIMEOUT_MS - 1));
    expect(startupBrandIntro.getSnapshot().pending).toEqual(['nomi']);
    act(() => vi.advanceTimersByTime(1));
    expect(startupBrandIntro.getSnapshot().pending).toEqual([]);
  });

  it('hung startup work still closes the cover at the hard timeout', () => {
    // 字体就绪与所有启动任务都永远不回
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise(() => undefined) },
    });
    try {
      startupBrandIntro.start('app');
      render(
        <>
          <StartupReady />
          <StartupBrandIntro />
        </>,
      );
      act(() => vi.advanceTimersByTime(WRITE_AND_HOLD_MS));
      expect(screen.getByTestId('startup-brand-intro').dataset.phase).toBe('waiting');
      // 后续不断开始新的加载也不能无限续命
      startupBrandIntro.taskStart('nomi');
      act(() => vi.advanceTimersByTime(STARTUP_HARD_TIMEOUT_MS - WRITE_AND_HOLD_MS - 1));
      expect(screen.queryByTestId('startup-brand-intro')).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByTestId('startup-brand-intro')).toBeNull();
      expect(startupBrandIntro.getSnapshot().phase).toBe('done');
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('a hung document.fonts.ready does not block the normal ready path', async () => {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: new Promise(() => undefined) },
    });
    try {
      startupBrandIntro.start('app');
      render(<StartupReady />);
      act(() => startupBrandIntro.drawn());
      for (const task of ['nomi', 'tabs', 'sidebar'] as const)
        act(() => startupBrandIntro.taskDone(task));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FONTS_READY_TIMEOUT_MS + LAYOUT_FRAME_FALLBACK_MS + 50);
      });
      expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('normal ready path releases on data + layout well before any timeout', async () => {
    startupBrandIntro.start('app');
    render(<StartupReady />);
    act(() => vi.advanceTimersByTime(WRITE_AND_HOLD_MS));
    act(() => startupBrandIntro.drawn());
    for (const task of ['nomi', 'tabs', 'sidebar'] as const)
      act(() => startupBrandIntro.taskDone(task));
    expect(startupBrandIntro.getSnapshot().phase).toBe('waiting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(startupBrandIntro.getSnapshot()).toMatchObject({ phase: 'revealing', forced: false });
  });

  it('re-waits for layout when a load starts and ends within one batch after revealing', async () => {
    startupBrandIntro.start('app');
    render(<StartupReady />);
    act(() => startupBrandIntro.drawn());
    act(() => {
      for (const task of ['nomi', 'tabs', 'sidebar'] as const) startupBrandIntro.taskDone(task);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
    act(() => {
      startupBrandIntro.taskStart('nomi');
      startupBrandIntro.taskDone('nomi');
    });
    expect(startupBrandIntro.getSnapshot().phase).toBe('waiting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
  });

  it('the revealing cover lets clicks through and drops its modal semantics', () => {
    startupBrandIntro.start('app');
    render(<StartupBrandIntro />);
    act(() => startupBrandIntro.drawn());
    for (const task of ['nomi', 'tabs', 'sidebar'] as const)
      act(() => startupBrandIntro.taskDone(task));
    act(() => startupBrandIntro.appReady());
    const cover = screen.getByTestId('startup-brand-intro');
    expect(cover.dataset.phase).toBe('revealing');
    // 淡出期间页面已经能点、能打字：遮罩不吃点击，也不再对读屏宣布自己是模态
    expect(cover.getAttribute('aria-hidden')).toBe('true');
    expect(cover.hasAttribute('aria-modal')).toBe(false);
  });

  it('keeps a static loading cover for reduced motion, then removes it when ready', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    startupBrandIntro.start('app');
    expect(startupBrandIntro.getSnapshot()).toMatchObject({ phase: 'waiting', skipped: true });
    startupBrandIntro.appReady();
    expect(startupBrandIntro.getSnapshot().phase).toBe('done');
  });

  it('preserves the original docking animation when the startup leads to onboarding', () => {
    startupBrandIntro.start('app');
    startupBrandIntro.showOnboarding();
    startupBrandIntro.setTarget(document.createElement('span'));
    startupBrandIntro.drawn();
    expect(startupBrandIntro.getSnapshot().phase).toBe('docking');
  });
});

it('holds the startup cover again when restoring the current conversation starts another load', () => {
  startupBrandIntro.start('app');
  startupBrandIntro.drawn();
  for (const task of ['nomi', 'tabs', 'sidebar'] as const) startupBrandIntro.taskDone(task);
  startupBrandIntro.appReady();
  expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
  startupBrandIntro.taskStart('nomi');
  expect(startupBrandIntro.getSnapshot()).toMatchObject({ phase: 'waiting', ready: false });
  startupBrandIntro.taskDone('nomi');
  startupBrandIntro.appReady();
  expect(startupBrandIntro.getSnapshot().phase).toBe('revealing');
});
