// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppEntries } from '../src/components/AppEntries';
import { ChatHeader } from '../src/components/ChatHeader';

afterEach(() => cleanup());

const handlers = () => ({
  onHub: vi.fn(),
  onExt: vi.fn(),
  onLocal: vi.fn(),
  onSettings: vi.fn(),
});

describe('侧栏底部的应用级入口', () => {
  it('展开时设置带文字；收起时只剩图标、竖排；testid 不变', () => {
    const h = handlers();
    const r = render(<AppEntries collapsed={false} {...h} />);
    const settings = r.getByTestId('open-settings');
    expect(settings.textContent).toContain('设置');
    expect(settings.title).toContain('设置');
    fireEvent.click(settings);
    expect(h.onSettings).toHaveBeenCalledTimes(1);

    r.rerender(<AppEntries collapsed {...h} />);
    expect(r.getByTestId('app-entries').hasAttribute('data-collapsed')).toBe(true);
    expect(r.getByTestId('open-settings').textContent).toBe('');
    expect(r.getByTestId('open-settings').getAttribute('aria-label')).toBe('设置');
  });

  it('顶栏不再放应用级入口', () => {
    const r = render(<ChatHeader trailing={<button type="button">rail</button>} />);
    expect(r.queryByTestId('open-settings')).toBeNull();
    expect(r.queryByTestId('open-hub-panel')).toBeNull();
    expect(r.getByText('rail')).toBeTruthy();
  });
});
