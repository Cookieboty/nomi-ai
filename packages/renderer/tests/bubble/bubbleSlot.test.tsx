// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bubbleSlot } from '../../src/mascot/bubbleSlot';

const state: { currentMessage: string | null; messageMore?: boolean } = { currentMessage: null };
vi.mock('@/contexts/MascotContext', () => ({
  useMascot: () => ({ state }),
  bubbleHover: { on: false },
}));

afterEach(() => {
  cleanup();
  bubbleSlot.setConfirmShown(false);
});

describe('one bubble beside the head at a time', () => {
  it('the line bubble yields while a desktop confirm bubble is shown, then comes back', async () => {
    const { MessageBubble } = await import('../../src/components/MessageBubble/MessageBubble');
    state.currentMessage = '先看看这个文件';
    const { container } = render(<MessageBubble />);
    const el = () => container.querySelector('[data-testid="mascot-bubble"]') as HTMLElement;
    expect(el().className).toMatch(/active/);
    expect(el().hasAttribute('data-empty')).toBe(false);

    act(() => bubbleSlot.setConfirmShown(true));
    expect(el().className).not.toMatch(/active/);
    expect(el().hasAttribute('data-empty')).toBe(true); // visibility:hidden，不会和确认气泡叠在一起
    expect(el().hasAttribute('data-yielded')).toBe(true);

    act(() => bubbleSlot.setConfirmShown(false));
    expect(el().className).toMatch(/active/);
    expect(el().textContent).toContain('先看看这个文件');
  });
});
