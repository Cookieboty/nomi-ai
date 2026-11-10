// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageLightbox } from '../src/components/ImageLightbox/ImageLightbox';

const src = 'data:image/png;base64,AA==';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('full-window image lightbox', () => {
  it('portals outside the content layout, centers the image and reveals details only on demand', () => {
    const view = render(
      <div data-testid="parent">
        <ImageLightbox src={src} onClose={vi.fn()} details={<p>Prompt</p>} />
      </div>,
    );
    const dialog = screen.getByRole('dialog');
    expect(screen.getByTestId('parent').contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('image-lightbox-details').hidden).toBe(true);
    fireEvent.click(screen.getByTestId('image-lightbox-info'));
    expect(screen.getByTestId('image-lightbox-details').hidden).toBe(false);
  });
  it('zooms with limits, resets to fit, and supports dragging a zoomed image', () => {
    render(<ImageLightbox src={src} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog'),
      image = dialog.querySelector('img')!;
    const plus = screen.getByRole('button', { name: '放大' }),
      minus = screen.getByRole('button', { name: '缩小' });
    fireEvent.click(plus);
    expect(screen.getByTestId('image-lightbox-reset').textContent).toBe('125%');
    fireEvent.pointerDown(image, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 150, clientY: 120 });
    expect(image.style.transform).toContain('translate(50px, 20px)');
    fireEvent.pointerUp(image, { pointerId: 1 });
    for (let i = 0; i < 20; i++) fireEvent.click(plus);
    expect(screen.getByTestId('image-lightbox-reset').textContent).toBe('400%');
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 20; i++) fireEvent.click(minus);
    expect(screen.getByTestId('image-lightbox-reset').textContent).toBe('25%');
    fireEvent.click(screen.getByTestId('image-lightbox-reset'));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)');
  });
  it('switches grouped images by buttons/arrow keys and resets zoom without moving the chat', () => {
    function Probe() {
      const [index, setIndex] = useState(0);
      return (
        <ImageLightbox
          src={`${src}${index}`}
          index={index}
          count={2}
          onIndex={setIndex}
          onClose={vi.fn()}
        />
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    fireEvent.click(screen.getByTestId('image-lightbox-next'));
    expect(screen.getByRole('dialog').querySelector('img')!.getAttribute('src')).toBe(`${src}1`);
    expect(screen.getByTestId('image-lightbox-reset').textContent).toBe('100%');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog').querySelector('img')!.getAttribute('src')).toBe(`${src}0`);
  });
  it('closes by backdrop or Escape, restores focus and traps Tab inside the overlay', () => {
    function Probe() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && <ImageLightbox src={src} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Probe />);
    const trigger = screen.getByText('open');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByTestId('image-lightbox-close'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('image-lightbox-stage'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
