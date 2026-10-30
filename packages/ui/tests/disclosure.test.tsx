import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Disclosure } from '../src';

afterEach(cleanup);

describe('Disclosure', () => {
  it('toggles with aria-expanded and keeps the body in the DOM while collapsed', () => {
    render(
      <Disclosure summary="详情" data-testid="d">
        <pre>堆栈</pre>
      </Disclosure>,
    );
    expect(document.querySelector('details')).toBeNull();
    const btn = screen.getByRole('button', { name: '详情' });
    const body = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(screen.getByTestId('d').textContent).toContain('堆栈');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(screen.getByTestId('d').hasAttribute('data-open')).toBe(true);
  });

  it('defaultOpen starts expanded', () => {
    render(
      <Disclosure summary="来源" defaultOpen>
        x
      </Disclosure>,
    );
    expect(screen.getByRole('button', { name: '来源' }).getAttribute('aria-expanded')).toBe('true');
  });
});
