// @vitest-environment happy-dom
/**
 * 静态立绘（#303）：macOS WebKit 上立绘是内嵌位图的 SVG，onload 时可能还没解码完，第一笔画出来是空的；
 * 画布还没布局（尺寸 0）时也不能按图片原尺寸画。要求：先解码再画、布局后再画、画空了自己重画。
 */
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import StaticCanvas, { painted } from '../src/canvas/StaticCanvas';

class FakeImage {
  static last: FakeImage | null = null;
  onload: (() => void) | null = null;
  decoding = '';
  naturalWidth = 0;
  naturalHeight = 0;
  complete = false;
  decode = vi.fn(async () => undefined);
  set src(_v: string) {
    FakeImage.last = this;
  }
  load() {
    this.naturalWidth = 1024;
    this.naturalHeight = 1536;
    this.complete = true;
    this.onload?.();
  }
}

let roCallbacks: Array<() => void> = [];
class FakeResizeObserver {
  constructor(private cb: () => void) {
    roCallbacks.push(cb);
  }
  observe() {}
  disconnect() {
    roCallbacks = roCallbacks.filter((c) => c !== this.cb);
  }
}

/** 前 blankDraws 次画完读回来是空的（模拟 WebKit 还没解码完内嵌位图） */
let blankDraws = 0;
let draws = 0;
const fakeCtx = (canvas: HTMLCanvasElement) => ({
  canvas,
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  drawImage: vi.fn(() => {
    draws += 1;
  }),
  getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    if (draws > blankDraws) data[3] = 255;
    return { data };
  }),
});

let size = { w: 0, h: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  draws = 0;
  blankDraws = 0;
  roCallbacks = [];
  size = { w: 0, h: 0 };
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const ctxs = new WeakMap<HTMLCanvasElement, ReturnType<typeof fakeCtx>>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    if (!ctxs.has(this)) ctxs.set(this, fakeCtx(this));
    return ctxs.get(this) as never;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.w);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.h);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('StaticCanvas (#303)', () => {
  it('waits for layout: nothing is drawn while the canvas is 0×0, then draws once it has a size', async () => {
    render(<StaticCanvas src="nomi.svg" />);
    FakeImage.last!.load();
    await flush();
    expect(FakeImage.last!.decode).toHaveBeenCalled();
    expect(draws).toBe(0);
    size = { w: 140, h: 210 };
    act(() => roCallbacks.forEach((cb) => cb()));
    expect(draws).toBe(1);
  });

  it('redraws by itself when the first paint comes out blank (no resize needed)', async () => {
    size = { w: 140, h: 210 };
    blankDraws = 2;
    render(<StaticCanvas src="nomi.svg" />);
    FakeImage.last!.load();
    await flush();
    expect(draws).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(draws).toBe(3);
    // 画上之后不再重画
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(draws).toBe(3);
  });

  it('painted() looks for any opaque pixel in the drawn area', () => {
    const canvas = { width: 10, height: 10 } as HTMLCanvasElement;
    const empty = new Uint8ClampedArray(10 * 10 * 4);
    const ctx = {
      canvas,
      getImageData: () => ({ data: empty }),
    } as unknown as CanvasRenderingContext2D;
    expect(painted(ctx, 0, 0, 10, 10)).toBe(false);
    empty[(5 * 10 + 5) * 4 + 3] = 200;
    expect(painted(ctx, 0, 0, 10, 10)).toBe(true);
  });
});
