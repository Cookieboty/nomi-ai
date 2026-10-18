// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let riveFailure: ((reason: string) => void) | undefined;

vi.mock('../../src/components/RiveMascot/RiveCanvas', () => ({
  default: ({ onFailure }: { onFailure?: (reason: string) => void }) => {
    riveFailure = onFailure;
    return <div data-testid="rive-canvas" />;
  },
}));
vi.mock('../../src/components/SpriteMascot/SpriteCanvas', () => ({
  default: ({ manifestPath }: { manifestPath: string }) => (
    <div data-testid="sprite-canvas" data-manifest={manifestPath} />
  ),
}));

import { Nomi2DCanvas } from '../../src/components/Mascot/Nomi2DCanvas';

afterEach(() => {
  cleanup();
  riveFailure = undefined;
  delete document.documentElement.dataset.mascotRenderer;
});

describe('Nomi2DCanvas', () => {
  it('renders Rive by default', async () => {
    render(<Nomi2DCanvas manifestPath="./assets/models/sprite/nomi/manifest.json" />);
    await screen.findByTestId('rive-canvas');
    expect(screen.queryByTestId('sprite-canvas')).toBeNull();
    expect(document.documentElement.dataset.mascotRenderer).toBeUndefined();
  });

  it('falls back to the layered 2D renderer when Rive reports a failure', async () => {
    render(<Nomi2DCanvas manifestPath="./assets/models/sprite/nomi/manifest.json" />);
    await screen.findByTestId('rive-canvas');
    React.act(() => riveFailure?.('Rive load failed'));
    const sprite = await screen.findByTestId('sprite-canvas');
    expect(sprite.getAttribute('data-manifest')).toBe('./assets/models/sprite/nomi/manifest.json');
    await waitFor(() => expect(screen.queryByTestId('rive-canvas')).toBeNull());
    expect(document.documentElement.dataset.mascotRenderer).toBe('sprite-fallback');
  });
});
