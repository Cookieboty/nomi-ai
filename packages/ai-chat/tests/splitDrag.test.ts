// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { startSplitDrag } from '../src/utils/splitDrag';

const setup = () => {
  const el = document.createElement('div');
  const captured = new Set<number>();
  el.setPointerCapture = (id: number) => void captured.add(id);
  el.releasePointerCapture = (id: number) => void captured.delete(id);
  el.hasPointerCapture = (id: number) => captured.has(id);
  const onMove = vi.fn();
  const onEnd = vi.fn();
  startSplitDrag({ el, pointerId: 1, onMove, onEnd });
  return { captured, onMove, onEnd };
};

const fire = (type: string) => window.dispatchEvent(new Event(type));

describe('startSplitDrag', () => {
  it('ignores another pointer ending while the captured pointer is dragging', () => {
    const { onEnd } = setup();
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }));
    expect(onEnd).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(onEnd).toHaveBeenCalledWith(false);
  });

  it('pointerup：正常结束，释放捕获，之后的移动不再响应', () => {
    const { captured, onMove, onEnd } = setup();
    expect(captured.has(1)).toBe(true);
    fire('pointermove');
    expect(onMove).toHaveBeenCalledTimes(1);
    fire('pointerup');
    expect(onEnd).toHaveBeenCalledWith(false);
    expect(captured.has(1)).toBe(false);
    fire('pointermove');
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('pointercancel：以 cancelled 结束，监听器被清掉（不会再跟随指针）', () => {
    const { captured, onMove, onEnd } = setup();
    fire('pointercancel');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(captured.has(1)).toBe(false);
    fire('pointermove');
    fire('pointerup');
    expect(onMove).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
