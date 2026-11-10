// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageLightbox } from '../src/components/ImageLightbox/ImageLightbox';
import { PreviewImageLightbox } from '../src/components/ResourcePreview/PreviewImageLightbox';

const src = 'data:image/png;base64,AA==';
const bounds = { left: 100, top: 50, width: 1000, height: 600 };
const anchor = { clientX: 850, clientY: 450 };
const point = { x: 250, y: 100 };

function transform() {
  const image = screen.getByRole('dialog').querySelector('img')!;
  const [, x, y, zoom] = /translate\(([^p]+)px, ([^p]+)px\) scale\(([^)]+)\)/.exec(
    image.style.transform,
  )!;
  return { x: Number(x), y: Number(y), zoom: Number(zoom) };
}
function expectAnchorFixed(before: ReturnType<typeof transform>) {
  const after = transform();
  expect(after.x + ((point.x - before.x) / before.zoom) * after.zoom).toBeCloseTo(point.x, 8);
  expect(after.y + ((point.y - before.y) / before.zoom) * after.zoom).toBeCloseTo(point.y, 8);
}
function wheelEvent(options: WheelEventInit) {
  const init = { bubbles: true, cancelable: true, ...anchor, ...options };
  const event = new WheelEvent('wheel', init);
  // happy-dom does not yet inherit MouseEvent coordinates/modifiers on WheelEvent.
  Object.defineProperties(event, {
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    ctrlKey: { value: init.ctrlKey ?? false },
  });
  return event;
}
function wheel(host: HTMLElement, options: WheelEventInit) {
  const event = wheelEvent(options);
  fireEvent(host, event);
  return event;
}
function gesture(host: HTMLElement, type: string, scale: number, position: object = anchor) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { scale, ...position });
  fireEvent(host, event);
  return event;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each([
  { name: 'global viewer', Lightbox: ImageLightbox },
  { name: 'document viewer', Lightbox: PreviewImageLightbox },
])('cursor-centered image zoom in $name', ({ Lightbox }) => {
  function setup(props: Partial<React.ComponentProps<typeof ImageLightbox>> = {}) {
    render(<Lightbox src={src} onClose={vi.fn()} {...props} />);
    const host = screen.getByTestId('image-lightbox-stage');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(bounds as DOMRect);
    Object.defineProperty(host, 'clientHeight', { value: bounds.height });
    return host;
  }

  it('zooms at the cursor with a wheel and reverses without moving the same image point', () => {
    const host = setup();
    const before = transform();
    const event = wheel(host, { deltaY: -100 });
    expect(event.defaultPrevented).toBe(true);
    expect(transform().zoom).toBeGreaterThan(1);
    expectAnchorFixed(before);
    wheel(host, { deltaY: 100 });
    expectAnchorFixed(before);
    expect(transform().zoom).toBeCloseTo(1);
    expect(transform().x).toBeCloseTo(0);
    expect(transform().y).toBeCloseTo(0);
  });

  it('handles rapid trackpad Ctrl+wheel events without losing updates or zooming the page', () => {
    const host = setup();
    const before = transform();
    const events = Array.from({ length: 3 }, () => wheelEvent({ ctrlKey: true, deltaY: -10 }));
    act(() => {
      for (const event of events) host.dispatchEvent(event);
    });
    expect(events.every((event) => event.defaultPrevented)).toBe(true);
    expect(transform().zoom).toBeCloseTo(Math.exp(0.3));
    expectAnchorFixed(before);
  });

  it('normalizes wheel line and page units', () => {
    const host = setup();
    wheel(host, { deltaY: -1, deltaMode: 1 });
    const line = transform().zoom;
    fireEvent.click(screen.getByTestId('image-lightbox-reset'));
    wheel(host, { deltaY: -16 });
    expect(transform().zoom).toBeCloseTo(line);
    fireEvent.click(screen.getByTestId('image-lightbox-reset'));
    wheel(host, { deltaY: -0.1, deltaMode: 2 });
    expect(transform().zoom).toBeCloseTo(Math.exp(0.12));
  });

  it('preserves the cursor anchor below fit size and can drag or reset an offset image', () => {
    const host = setup();
    const before = transform();
    wheel(host, { deltaY: 100, ctrlKey: true });
    expect(transform().zoom).toBeLessThan(1);
    expectAnchorFixed(before);
    const image = screen.getByRole('dialog').querySelector('img')!;
    expect(image.hasAttribute('data-zoomed')).toBe(true);
    const offset = transform();
    fireEvent.pointerDown(image, { button: 0, pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 230, clientY: 180 });
    fireEvent.pointerUp(image, { pointerId: 1 });
    expect(transform().x).toBeCloseTo(offset.x + 30);
    expect(transform().y).toBeCloseTo(offset.y - 20);
    fireEvent.doubleClick(image);
    expect(transform()).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it('clamps zoom without drifting at the limits and immediately responds when reversing', () => {
    const host = setup();
    const before = transform();
    for (let i = 0; i < 10; i++) wheel(host, { deltaY: -100, ctrlKey: true });
    expect(transform().zoom).toBe(4);
    expectAnchorFixed(before);
    wheel(host, { deltaY: 10, ctrlKey: true });
    expect(transform().zoom).toBeLessThan(4);
    expectAnchorFixed(before);
    for (let i = 0; i < 10; i++) wheel(host, { deltaY: 100, ctrlKey: true });
    expect(transform().zoom).toBe(0.25);
    expectAnchorFixed(before);
    wheel(host, { deltaY: -10, ctrlKey: true });
    expect(transform().zoom).toBeGreaterThan(0.25);
    expectAnchorFixed(before);
  });

  it('handles WebKit pinch scales without also applying overlapping wheel events', () => {
    const host = setup();
    const before = transform();
    expect(gesture(host, 'gesturestart', 1).defaultPrevented).toBe(true);
    expect(gesture(host, 'gesturechange', 2).defaultPrevented).toBe(true);
    expect(transform().zoom).toBe(2);
    expectAnchorFixed(before);
    wheel(host, { deltaY: -100, ctrlKey: true });
    expect(transform().zoom).toBe(2);
    gesture(host, 'gesturechange', 1.5);
    expect(transform().zoom).toBe(1.5);
    expectAnchorFixed(before);
    gesture(host, 'gestureend', 1.5);
    wheel(host, { deltaY: -10 });
    expect(transform().zoom).toBeGreaterThan(1.5);
    expectAnchorFixed(before);
  });

  it('uses the last pointer location when a pinch event has no coordinates', () => {
    const host = setup();
    const before = transform();
    fireEvent.pointerMove(screen.getByRole('dialog').querySelector('img')!, anchor);
    gesture(host, 'gesturestart', 1, {});
    gesture(host, 'gesturechange', 2, {});
    expect(transform().zoom).toBe(2);
    expectAnchorFixed(before);
  });

  it('ignores zoom input while loading or after an image fails', () => {
    const host = setup({ pending: true });
    wheel(host, { deltaY: -100 });
    gesture(host, 'gesturestart', 1);
    gesture(host, 'gesturechange', 2);
    expect(screen.getByTestId('image-lightbox-reset').textContent).toBe('100%');
    cleanup();
    const ready = setup();
    fireEvent.error(screen.getByRole('dialog').querySelector('img')!);
    wheel(ready, { deltaY: -100 });
    expect(screen.getByTestId('image-lightbox-reset').textContent).toBe('100%');
    expect((screen.getByRole('button', { name: '放大' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
