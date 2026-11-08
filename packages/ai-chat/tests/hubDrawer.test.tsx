// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubDrawer } from '../src/components/HubDrawer';

afterEach(() => cleanup());

describe('知识 · 记忆 · 日程抽屉', () => {
  it('右侧抽屉：知识库 / 长期记忆 / 日程三个标签可切换；「在设置中打开」带上当前标签', () => {
    const onOpenSettings = vi.fn();
    const r = render(<HubDrawer open onClose={() => undefined} onOpenSettings={onOpenSettings} />);
    const drawer = r.getByTestId('hub-drawer');
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.className).toContain('cd-modal--drawer');
    expect(r.getByTestId('settings-knowledge').getAttribute('data-tab')).toBe('kb');
    fireEvent.click(r.getByTestId('settings-knowledge-tab-memory'));
    expect(r.getByTestId('settings-knowledge').getAttribute('data-tab')).toBe('memory');
    fireEvent.click(r.getByTestId('open-in-settings'));
    expect(onOpenSettings).toHaveBeenCalledWith('memory');
  });

  it('关着时不渲染', () => {
    const r = render(<HubDrawer open={false} onClose={() => undefined} onOpenSettings={vi.fn()} />);
    expect(r.queryByTestId('hub-drawer')).toBeNull();
  });
});
