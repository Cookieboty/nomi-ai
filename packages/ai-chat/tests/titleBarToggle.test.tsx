// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppTitleBar, hasAppTitleBar } from '../src/components/TitleBar';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
});

describe('窗口标题栏', () => {
  it('只保留标题，不再显示独立侧栏开关', () => {
    const view = render(<AppTitleBar />);
    expect(view.getByTestId('app-titlebar').textContent).toBe('Nomi');
    expect(view.queryByTestId('sidebar-toggle')).toBeNull();
    expect(view.queryByRole('button')).toBeNull();
  });

  it('只有桌面应用（html[data-platform]）才算有标题栏', () => {
    expect(hasAppTitleBar()).toBe(false);
    document.documentElement.dataset.platform = 'darwin';
    expect(hasAppTitleBar()).toBe(true);
  });
});
