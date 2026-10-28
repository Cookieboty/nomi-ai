import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTitleTooltips } from '../src/titleTooltips';

let uninstall: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  uninstall = installTitleTooltips();
});
afterEach(() => {
  uninstall();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const over = (el: Element, related: Element | null = null) =>
  el.dispatchEvent(
    new PointerEvent('pointerover', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: related,
    }),
  );
const out = (el: Element, related: Element | null = null) =>
  el.dispatchEvent(
    new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: related }),
  );
const tip = () => document.querySelector('[role="tooltip"]');

describe('installTitleTooltips', () => {
  it('replaces the native title with an in-app tooltip and restores it on leave', () => {
    document.body.innerHTML = '<button title="删除会话"><svg></svg></button><p>x</p>';
    const btn = document.querySelector('button')!;
    over(btn);
    // 系统提示不会出现：title 已摘下；无文字的图标按钮临时补上无障碍名称
    expect(btn.hasAttribute('title')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('删除会话');
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(500);
    expect(tip()?.textContent).toBe('删除会话');
    expect(tip()?.className).toContain('cd-floating-tip');
    out(btn, document.querySelector('p'));
    expect(tip()).toBeNull();
    expect(btn.getAttribute('title')).toBe('删除会话');
    expect(btn.hasAttribute('aria-label')).toBe(false);
  });

  it('hovering a child keeps the tooltip; labelled elements get aria-describedby', () => {
    document.body.innerHTML = '<div title="完整路径"><span>短名</span></div>';
    const div = document.querySelector('div')!;
    const span = document.querySelector('span')!;
    over(span);
    vi.advanceTimersByTime(500);
    expect(tip()?.textContent).toBe('完整路径');
    expect(div.getAttribute('aria-describedby')).toBe(tip()!.id);
    out(div, span);
    over(span, div);
    expect(tip()?.textContent).toBe('完整路径');
  });

  it('moves straight to the next titled element without the delay', () => {
    document.body.innerHTML = '<button title="A">a</button><button title="B">b</button>';
    const [a, b] = document.querySelectorAll('button');
    over(a);
    vi.advanceTimersByTime(500);
    out(a, b);
    over(b, a);
    expect(a.getAttribute('title')).toBe('A');
    vi.advanceTimersByTime(0);
    expect(tip()?.textContent).toBe('B');
  });

  it('picks up a title React rewrites while hovered, and hides on click', async () => {
    document.body.innerHTML = '<button title="复制">c</button>';
    const btn = document.querySelector('button')!;
    over(btn);
    vi.advanceTimersByTime(500);
    btn.setAttribute('title', '已复制');
    await Promise.resolve();
    expect(btn.hasAttribute('title')).toBe(false);
    expect(tip()?.textContent).toBe('已复制');
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(tip()).toBeNull();
    out(btn);
    expect(btn.getAttribute('title')).toBe('已复制');
  });
});
