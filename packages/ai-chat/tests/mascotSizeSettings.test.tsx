// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MascotSizeSettings } from '../src/components/SettingsView/MascotSizeSettings';

const st = (scale: number, max = 1.5) => ({
  scale,
  min: 0.3,
  max,
  hardMax: 1.5,
  default: 0.5,
  step: 0.1,
  window: { width: 330, height: 355 },
});

function install(max = 1.5) {
  let cur = 0.5;
  let push: ((s: ReturnType<typeof st>) => void) | null = null;
  const api = {
    scaleGet: vi.fn(async () => st(cur, max)),
    scaleSet: vi.fn(async (v: number) => st((cur = Math.min(max, v)), max)),
    scaleReset: vi.fn(async () => st((cur = 0.5), max)),
    onScale: vi.fn((cb: (s: ReturnType<typeof st>) => void) => {
      push = cb;
      return () => undefined;
    }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { mascot: api };
  return { api, push: (v: number) => push?.(st(v, max)) };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('Settings → General → mascot size', () => {
  it('renders nothing without the desktop bridge', () => {
    const { container } = render(<MascotSizeSettings />);
    expect(container.innerHTML).toBe('');
  });

  it('slider range comes from the main process; changes are sent and synced back', async () => {
    const { api, push } = install();
    const { getByTestId } = render(<MascotSizeSettings />);
    await act(async () => {});
    const slider = getByTestId('mascot-size-slider') as HTMLInputElement;
    expect([slider.min, slider.max, slider.value]).toEqual(['0.3', '1.5', '0.5']);
    expect(getByTestId('mascot-size-value').textContent).toBe('50%');
    fireEvent.change(slider, { target: { value: '1.2' } });
    expect(api.scaleSet).toHaveBeenCalledWith(1.2);
    await act(async () => {});
    expect(getByTestId('mascot-size-value').textContent).toBe('120%');
    // another entry point (Ctrl+wheel / right-click menu) changes it: the slider follows
    act(() => push(0.8));
    expect(getByTestId('mascot-size-value').textContent).toBe('80%');
    expect((getByTestId('mascot-size-slider') as HTMLInputElement).value).toBe('0.8');
    fireEvent.click(getByTestId('mascot-size-plus'));
    expect(api.scaleSet).toHaveBeenLastCalledWith(0.9);
    await act(async () => {});
    fireEvent.click(getByTestId('mascot-size-reset'));
    await act(async () => {});
    expect(api.scaleReset).toHaveBeenCalled();
    expect(getByTestId('mascot-size-value').textContent).toBe('50%');
    expect((getByTestId('mascot-size-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('small display: the slider max is the display cap and the hint says so', async () => {
    install(1.25);
    const { getByTestId } = render(<MascotSizeSettings />);
    await act(async () => {});
    expect((getByTestId('mascot-size-slider') as HTMLInputElement).max).toBe('1.25');
    expect(getByTestId('mascot-size-cap').textContent).toContain('125%');
  });
});
