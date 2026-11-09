// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaticCanvas } from '../src/canvas/StaticCanvas';

vi.mock('../src/host', () => ({
  useAvatarContext: () => ({
    mark: vi.fn(),
    runtime: { flag: vi.fn(), registry: { attach: () => vi.fn() } },
  }),
}));
vi.mock('../src/canvas/InteractionLite', () => ({ default: () => null }));

class TestImage {
  static instances: TestImage[] = [];
  onload: (() => void | Promise<void>) | null = null;
  src = '';
  decoding = '';
  complete = true;
  naturalWidth = 1024;
  naturalHeight = 1536;
  decode = vi.fn(() => Promise.resolve());
  constructor() {
    TestImage.instances.push(this);
  }
}

let width: number;
let height: number;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let observers: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[];
const drawImage = vi.fn();
const context = { setTransform: vi.fn(), clearRect: vi.fn(), drawImage };

beforeEach(() => {
  width = 246;
  height = 265;
  frames = new Map();
  nextFrame = 1;
  observers = [];
  TestImage.instances = [];
  vi.stubGlobal('Image', TestImage);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, disconnect: this.disconnect });
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function load(image = TestImage.instances.at(-1)!) {
  await act(async () => {
    await image.onload?.();
  });
}
function frame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
function resizeContainer() {
  act(() => observers.at(-1)!.callback([], {} as ResizeObserver));
}

describe('static canvas first frame', () => {
  it('decodes then draws on a layout frame, with no continuous render loop', async () => {
    const { container } = render(<StaticCanvas src="/character.svg" />);
    expect(drawImage).not.toHaveBeenCalled();
    await load();
    expect(drawImage).not.toHaveBeenCalled();
    frame();
    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(492);
    expect(canvas.height).toBe(530);
    expect(drawImage).toHaveBeenCalledWith(TestImage.instances[0], 78, 130, 90, 135);
    expect(frames.size).toBe(0);
  });

  it('does not draw from resize notifications before image decoding completes', async () => {
    render(<StaticCanvas src="/character.svg" />);
    let resolve!: () => void;
    TestImage.instances[0].decode.mockImplementation(
      () => new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const pending = TestImage.instances[0].onload!();
    resizeContainer();
    window.dispatchEvent(new Event('resize'));
    frame();
    expect(drawImage).not.toHaveBeenCalled();
    await act(async () => {
      resolve();
      await pending;
    });
    frame();
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it('waits for a zero-size canvas to become visible without a window resize', async () => {
    width = height = 0;
    render(<StaticCanvas src="/character.svg" />);
    await load();
    frame();
    expect(drawImage).not.toHaveBeenCalled();
    width = 246;
    height = 265;
    resizeContainer();
    frame();
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it('coalesces container and window changes and repaints the new dimensions', async () => {
    render(<StaticCanvas src="/character.svg" />);
    await load();
    frame();
    width = 288;
    height = 310;
    resizeContainer();
    resizeContainer();
    window.dispatchEvent(new Event('resize'));
    expect(frames.size).toBe(1);
    frame();
    expect(drawImage).toHaveBeenLastCalledWith(TestImage.instances[0], 84, 130, 120, 180);
  });

  it('repaints on presentation restoration without changing size', async () => {
    render(<StaticCanvas src="/character.svg" />);
    await load();
    frame();
    window.dispatchEvent(new Event('pageshow'));
    frame();
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });

  it('only repaints visibility changes when the document is visible', async () => {
    render(<StaticCanvas src="/character.svg" />);
    await load();
    frame();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    frame();
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('retains the loaded SVG fallback if decode rejects', async () => {
    render(<StaticCanvas src="/character.svg" />);
    TestImage.instances[0].decode.mockRejectedValue(new Error('SVG decode unavailable'));
    await load();
    frame();
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it('does not paint an old image when its decode finishes after the source changes', async () => {
    const { rerender } = render(<StaticCanvas src="/old.svg" />);
    let resolve!: () => void;
    TestImage.instances[0].decode.mockImplementation(
      () => new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const pending = TestImage.instances[0].onload!();
    rerender(<StaticCanvas src="/new.svg" />);
    await act(async () => {
      resolve();
      await pending;
    });
    expect(frames.size).toBe(0);
    await load();
    frame();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(drawImage.mock.calls[0][0]).toBe(TestImage.instances[1]);
  });

  it('cancels queued drawing and disconnects layout observers on unmount', async () => {
    const { unmount } = render(<StaticCanvas src="/character.svg" />);
    await load();
    expect(frames.size).toBe(1);
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    window.dispatchEvent(new Event('resize'));
    frame();
    expect(drawImage).not.toHaveBeenCalled();
  });
});
