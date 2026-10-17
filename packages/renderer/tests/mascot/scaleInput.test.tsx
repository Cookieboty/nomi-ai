// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = (scale: number) => ({
  scale,
  min: 0.3,
  max: 1.5,
  hardMax: 1.5,
  default: 0.5,
  step: 0.1,
  window: { width: 330, height: 355 },
});

function install() {
  let cur = 0.5;
  let push: ((s: ReturnType<typeof state>) => void) | null = null;
  const api = {
    scaleGet: vi.fn(async () => state(cur)),
    scaleWheel: vi.fn(async (dy: number) => {
      cur = Math.round(Math.min(1.5, Math.max(0.3, cur * Math.exp(-dy * 0.002))) * 100) / 100;
      return state(cur);
    }),
    scaleStep: vi.fn(async (d: number) => {
      cur = Math.round((cur + d * 0.1) * 100) / 100;
      return state(cur);
    }),
    scaleSet: vi.fn(async (v: number) => state((cur = v))),
    scaleReset: vi.fn(async () => state((cur = 0.5))),
    onScale: vi.fn((cb: (s: ReturnType<typeof state>) => void) => {
      push = cb;
      return () => undefined;
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { mascotWindow: api };
  return { api, push: (s: number) => push?.(state(s)) };
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.useRealTimers();
});

describe('mascot zoom input', () => {
  it('Ctrl/⌘ + wheel zooms (prevented, coalesced per frame); plain wheel does nothing', async () => {
    const { api } = install();
    const { useMascotZoomInput } = await import('../../src/mascot/scaleStore');
    const Probe: React.FC = () => {
      useMascotZoomInput();
      return null;
    };
    render(<Probe />);
    const plain = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    Object.defineProperty(plain, 'ctrlKey', { value: false });
    window.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);

    const ev = (init: WheelEventInit) => {
      const e = new WheelEvent('wheel', { cancelable: true, ...init });
      // happy-dom does not copy the modifier flags from the init dict
      for (const k of ['ctrlKey', 'metaKey'] as const)
        Object.defineProperty(e, k, { value: !!init[k] });
      window.dispatchEvent(e);
      return e;
    };
    expect(ev({ deltaY: -50, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(ev({ deltaY: -50, metaKey: true }).defaultPrevented).toBe(true);
    expect(api.scaleWheel).not.toHaveBeenCalled(); // coalesced until the next frame
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(api.scaleWheel).toHaveBeenCalledTimes(1);
    expect(api.scaleWheel).toHaveBeenCalledWith(-100, 0);
  });

  it('Ctrl/⌘ + / - / 0 step and reset; typing in inputs is left alone', async () => {
    const { api } = install();
    const { useMascotZoomInput } = await import('../../src/mascot/scaleStore');
    const Probe: React.FC = () => {
      useMascotZoomInput();
      return <input data-testid="in" />;
    };
    const { getByTestId } = render(<Probe />);
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    fireEvent.keyDown(window, { key: '-', metaKey: true });
    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    expect(api.scaleStep).toHaveBeenNthCalledWith(1, 1);
    expect(api.scaleStep).toHaveBeenNthCalledWith(2, -1);
    expect(api.scaleReset).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByTestId('in'), { key: '=', ctrlKey: true });
    fireEvent.keyDown(window, { key: '=' });
    expect(api.scaleStep).toHaveBeenCalledTimes(2);
  });
});

describe('mascot right-click menu', () => {
  it('opens on the character only, zooms, keeps open, disables at the limits, Esc closes', async () => {
    const { api, push } = install();
    const { MascotContextMenu } = await import('../../src/components/Mascot/MascotContextMenu');
    const { container, queryByTestId, getByTestId } = render(
      <div>
        <div id="mascot-canvas" data-testid="stage">
          <canvas data-testid="cv" />
        </div>
        <div data-mascot-ui data-testid="ui">
          <button type="button">x</button>
        </div>
        <MascotContextMenu />
      </div>,
    );
    await act(async () => {});
    // the toolbar / other UI keeps its own right-click behaviour
    fireEvent.contextMenu(container.querySelector('[data-testid="ui"] button')!);
    expect(queryByTestId('mascot-context-menu')).toBeNull();
    // the character → menu with data-mascot-ui (click-through hit test counts it)
    fireEvent.contextMenu(getByTestId('cv'), { clientX: 20, clientY: 30 });
    const menu = getByTestId('mascot-context-menu');
    expect(menu.hasAttribute('data-mascot-ui')).toBe(true);
    expect(getByTestId('ctx-scale-value').textContent).toContain('50%');
    expect((getByTestId('ctx-zoom-reset') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByTestId('ctx-zoom-in'));
    expect(api.scaleStep).toHaveBeenCalledWith(1);
    await act(async () => {});
    expect(getByTestId('ctx-scale-value').textContent).toContain('60%');
    expect(queryByTestId('mascot-context-menu')).not.toBeNull(); // stays open for repeated clicks
    act(() => push(1.5));
    expect((getByTestId('ctx-zoom-in') as HTMLButtonElement).disabled).toBe(true);
    act(() => push(0.3));
    expect((getByTestId('ctx-zoom-out') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByTestId('ctx-zoom-reset'));
    expect(api.scaleReset).toHaveBeenCalled();
    expect(queryByTestId('mascot-context-menu')).toBeNull(); // reset closes
    fireEvent.contextMenu(getByTestId('cv'), { clientX: 5, clientY: 5 });
    expect(queryByTestId('mascot-context-menu')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByTestId('mascot-context-menu')).toBeNull();
  });
});
