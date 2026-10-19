// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let lastOnError: ((m: string) => void) | undefined;
const canvasProps: Array<{ modelPath: string }> = [];
vi.mock('../../src/components/VirtualCharacter3D/Character3DCanvas', () => ({
  Character3DCanvas: (p: { modelPath: string; onError?: (m: string) => void }) => {
    lastOnError = p.onError;
    canvasProps.push({ modelPath: p.modelPath });
    return <div data-testid="canvas" data-path={p.modelPath} />;
  },
}));

import { CanvasBoundary } from '../../src/components/Mascot/CanvasBoundary';
import { VirtualCharacter3D } from '../../src/components/VirtualCharacter3D';

afterEach(() => {
  cleanup();
  lastOnError = undefined;
  canvasProps.length = 0;
  vi.restoreAllMocks();
});

describe('VirtualCharacter3D：模型加载失败后可通过切换到有效模型恢复（#38）', () => {
  it('A 的加载错误显示错误 UI；换成 B 后错误消失并挂载 B 的画布', async () => {
    const { rerender, findByText, queryByText, getByTestId } = render(
      <VirtualCharacter3D modelPath="/models/a.vrm" />,
    );
    await vi.waitFor(() => expect(getByTestId('canvas').dataset.path).toBe('/models/a.vrm'));
    React.act(() => lastOnError!('A 解析失败'));
    expect(await findByText('A 解析失败')).toBeTruthy();
    expect(screen.queryByTestId('canvas')).toBeNull();

    rerender(<VirtualCharacter3D modelPath="/models/b.vrm" />);
    await vi.waitFor(() => expect(screen.getByTestId('canvas').dataset.path).toBe('/models/b.vrm'));
    expect(queryByText('A 解析失败')).toBeNull();
  });

  it('B 自己再失败时仍会显示 B 的错误（不是无条件清错）', async () => {
    const { rerender, findByText, getByTestId } = render(
      <VirtualCharacter3D modelPath="/models/a.vrm" />,
    );
    await vi.waitFor(() => getByTestId('canvas'));
    React.act(() => lastOnError!('A 失败'));
    rerender(<VirtualCharacter3D modelPath="/models/b.vrm" />);
    await vi.waitFor(() => expect(getByTestId('canvas').dataset.path).toBe('/models/b.vrm'));
    React.act(() => lastOnError!('B 失败'));
    expect(await findByText('B 失败')).toBeTruthy();
  });
});

describe('VirtualCharacter3D：切回失败过的模型 / 原地重试都会重新加载（#38）', () => {
  it('A 失败 → B → 切回 A：不显示 A 的旧错误，重新挂载 A 的画布', async () => {
    const { rerender, findByText, queryByText } = render(
      <VirtualCharacter3D modelPath="/models/a.vrm" />,
    );
    await vi.waitFor(() => screen.getByTestId('canvas'));
    React.act(() => lastOnError!('A 解析失败'));
    expect(await findByText('A 解析失败')).toBeTruthy();
    rerender(<VirtualCharacter3D modelPath="/models/b.vrm" />);
    await vi.waitFor(() => expect(screen.getByTestId('canvas').dataset.path).toBe('/models/b.vrm'));
    canvasProps.length = 0;
    rerender(<VirtualCharacter3D modelPath="/models/a.vrm" />);
    await vi.waitFor(() => expect(screen.getByTestId('canvas').dataset.path).toBe('/models/a.vrm'));
    expect(queryByText('A 解析失败')).toBeNull();
    expect(canvasProps.some((p) => p.modelPath === '/models/a.vrm')).toBe(true);
  });

  it('同一个模型失败后点「重试」：重新挂载画布再加载一次', async () => {
    const { findByText, getByTestId } = render(<VirtualCharacter3D modelPath="/models/a.vrm" />);
    await vi.waitFor(() => getByTestId('canvas'));
    React.act(() => lastOnError!('网络中断'));
    expect(await findByText('网络中断')).toBeTruthy();
    canvasProps.length = 0;
    React.act(() => getByTestId('character3d-retry').click());
    await vi.waitFor(() => expect(getByTestId('canvas').dataset.path).toBe('/models/a.vrm'));
    expect(canvasProps).toEqual(expect.arrayContaining([{ modelPath: '/models/a.vrm' }]));
  });
});

describe('CanvasBoundary：resetKey 变化后复位（#38）', () => {
  const Boom: React.FC<{ explode: boolean }> = ({ explode }) => {
    if (explode) throw new Error('webgl');
    return <div data-testid="ok" />;
  };

  it('3D 子树抛错 → 降级图标；换模型（resetKey 变）后重新挂载新子树', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender, queryByTestId, getByTestId } = render(
      <CanvasBoundary resetKey="vrm-a">
        <Boom explode />
      </CanvasBoundary>,
    );
    expect(getByTestId('mascot-canvas-fallback')).toBeTruthy();
    // 同一个 key 重渲染：保持降级，不会循环重试
    rerender(
      <CanvasBoundary resetKey="vrm-a">
        <Boom explode />
      </CanvasBoundary>,
    );
    expect(getByTestId('mascot-canvas-fallback')).toBeTruthy();
    // 选了另一个模型（例如 sprite）：边界复位，新子树正常显示
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
