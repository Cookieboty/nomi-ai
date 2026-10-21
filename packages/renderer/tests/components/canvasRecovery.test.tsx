// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasBoundary } from '../../src/components/Mascot/CanvasBoundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CanvasBoundary：resetKey 变化后复位（#38）', () => {
  const Boom: React.FC<{ explode: boolean }> = ({ explode }) => {
    if (explode) throw new Error('webgl');
    return <div data-testid="ok" />;
  };

  it('画布子树抛错 → 降级图标；换模型（resetKey 变）后重新挂载新子树', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender, queryByTestId, getByTestId } = render(
      <CanvasBoundary resetKey="nomi-a">
        <Boom explode />
      </CanvasBoundary>,
    );
    expect(getByTestId('mascot-canvas-fallback')).toBeTruthy();
    // 同一个 key 重渲染：保持降级，不会循环重试
    rerender(
      <CanvasBoundary resetKey="nomi-a">
        <Boom explode />
      </CanvasBoundary>,
    );
    expect(getByTestId('mascot-canvas-fallback')).toBeTruthy();
    // 选了另一个模型（例如重新加载）：边界复位，新子树正常显示
    rerender(
      <CanvasBoundary resetKey="sprite-b">
        <Boom explode={false} />
      </CanvasBoundary>,
    );
    expect(queryByTestId('mascot-canvas-fallback')).toBeNull();
    expect(getByTestId('ok')).toBeTruthy();
  });

  it('新模型的子树又抛错时，会再次降级', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender, getByTestId } = render(
      <CanvasBoundary resetKey="a">
        <Boom explode />
      </CanvasBoundary>,
    );
    rerender(
      <CanvasBoundary resetKey="b">
        <Boom explode />
      </CanvasBoundary>,
    );
    expect(getByTestId('mascot-canvas-fallback')).toBeTruthy();
  });
});
