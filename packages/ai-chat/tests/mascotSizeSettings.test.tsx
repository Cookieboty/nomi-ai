// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MascotSizeSettings } from '../src/components/SettingsView/MascotSizeSettings';

import { installMascotHost, publishMascotEvent, resetMascotHost } from './helpers/mascotHost';

vi.mock('../src/services/api', async () =>
  (await import('./helpers/mascotHost')).mascotApiModule(),
);

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
  const api = {
    scaleGet: vi.fn(async () => st(cur, max)),
    scaleSet: vi.fn(async (v: number) => st((cur = Math.min(max, v)), max)),
    scaleReset: vi.fn(async () => st((cur = 0.5), max)),
  };
  // 契约 mascot.scale*（对话窗口调用）→ 记录成原来的位置参数
  installMascotHost({
    'mascot.scaleGet': () => api.scaleGet(),
    'mascot.scaleSet': ({ scale }) => api.scaleSet(scale),
    'mascot.scaleReset': () => api.scaleReset(),
  });
  return { api, push: (v: number) => publishMascotEvent('mascot.scaleChanged', st(v, max)) };
}

/** 等契约往返（in-process 传输按微任务 / 宏任务投递） */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

afterEach(() => {
  cleanup();
  resetMascotHost();
});

describe('Settings → General → mascot size', () => {
  it('renders nothing without the desktop bridge', () => {
    const { container } = render(<MascotSizeSettings />);
    expect(container.innerHTML).toBe('');
  });

  it('slider range comes from the main process; changes are sent and synced back', async () => {
    const { api, push } = install();
    const { getByTestId } = render(<MascotSizeSettings />);
    await settle();
    const slider = getByTestId('mascot-size-slider') as HTMLInputElement;
    expect([slider.min, slider.max, slider.value]).toEqual(['0.3', '1.5', '0.5']);
    expect(getByTestId('mascot-size-value').textContent).toBe('50%');
    fireEvent.change(slider, { target: { value: '1.2' } });
    await settle();
    expect(api.scaleSet).toHaveBeenCalledWith(1.2);
    expect(getByTestId('mascot-size-value').textContent).toBe('120%');
    // another entry point (Ctrl+wheel / right-click menu) changes it: the slider follows
    await act(() => push(0.8));
    expect(getByTestId('mascot-size-value').textContent).toBe('80%');
    expect((getByTestId('mascot-size-slider') as HTMLInputElement).value).toBe('0.8');
    fireEvent.click(getByTestId('mascot-size-plus'));
    await settle();
    expect(api.scaleSet).toHaveBeenLastCalledWith(0.9);
    fireEvent.click(getByTestId('mascot-size-reset'));
    await settle();
    expect(api.scaleReset).toHaveBeenCalled();
    expect(getByTestId('mascot-size-value').textContent).toBe('50%');
    expect((getByTestId('mascot-size-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('small display: the slider max is the display cap and the hint says so', async () => {
    install(1.25);
    const { getByTestId } = render(<MascotSizeSettings />);
    await settle();
    expect((getByTestId('mascot-size-slider') as HTMLInputElement).max).toBe('1.25');
    expect(getByTestId('mascot-size-cap').textContent).toContain('125%');
  });
});
