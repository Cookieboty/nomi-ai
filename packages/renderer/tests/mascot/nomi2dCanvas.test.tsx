// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Nomi2DCanvas } from '../../src/components/Mascot/Nomi2DCanvas';
import { resetCharacterPackOverlayForTest } from '../../src/mascot/characterConfig';

import { installMascotHost, packSnapshot, resetMascotHost } from './mascotHost';

vi.mock('../../src/services/api', async () => (await import('./mascotHost')).mascotApiModule());

let riveFailure: ((reason: string) => void) | undefined;
let lastRiveSrc: string | undefined;
let lastStaticSrc: string | undefined;

vi.mock('../../src/components/RiveMascot/RiveCanvas', () => ({
  default: ({ onFailure, src }: { onFailure?: (reason: string) => void; src?: string }) => {
    riveFailure = onFailure;
    lastRiveSrc = src;
    return <div data-testid="rive-canvas" data-rive-src={src ?? ''} />;
  },
}));
vi.mock('../../src/components/SpriteMascot/SpriteCanvas', () => ({
  default: ({ manifestPath }: { manifestPath: string }) => (
    <div data-testid="sprite-canvas" data-manifest={manifestPath} />
  ),
}));
vi.mock('../../src/components/StaticMascot/StaticCanvas', () => ({
  default: ({ src }: { src?: string }) => {
    lastStaticSrc = src;
    return <div data-testid="static-canvas" data-static-src={src ?? ''} />;
  },
}));

afterEach(() => {
  cleanup();
  riveFailure = undefined;
  lastRiveSrc = undefined;
  lastStaticSrc = undefined;
  resetCharacterPackOverlayForTest();
  resetMascotHost();
  delete document.documentElement.dataset.mascotRenderer;
});

beforeEach(() => {
  resetCharacterPackOverlayForTest();
});

describe('Nomi2DCanvas', () => {
  it('renders Rive by default after overlay settles', async () => {
    render(<Nomi2DCanvas manifestPath="./assets/models/sprite/nomi/manifest.json" />);
    await screen.findByTestId('rive-canvas');
    expect(screen.queryByTestId('sprite-canvas')).toBeNull();
    expect(document.documentElement.dataset.mascotRenderer).toBeUndefined();
    expect(lastRiveSrc).toBeTruthy();
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

  it('waits for overlay then switches to StaticCanvas with overlay staticUrl', async () => {
    let resolveActive!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveActive = r;
    });
    installMascotHost({
      'character.getActivePack': async () =>
        packSnapshot((await pending) as Record<string, unknown>),
    });

    render(<Nomi2DCanvas manifestPath="./assets/models/sprite/nomi/manifest.json" />);
    expect(screen.queryByTestId('rive-canvas')).toBeNull();
    expect(screen.queryByTestId('static-canvas')).toBeNull();

    await act(async () => {
      resolveActive({
        source: 'userData',
        id: 'static-demo',
        mode: 'static',
        riveUrl: null,
        staticUrl: 'character-pack://pack/static/character.webp',
        voiceBaseUrl: null,
        hitboxes: null,
        rive: null,
      });
      await pending;
    });

    const staticEl = await screen.findByTestId('static-canvas');
    expect(staticEl.getAttribute('data-static-src')).toBe(
      'character-pack://pack/static/character.webp',
    );
    expect(lastStaticSrc).toBe('character-pack://pack/static/character.webp');
    expect(screen.queryByTestId('rive-canvas')).toBeNull();
  });

  it('passes overlay riveUrl into RiveCanvas src', async () => {
    const riv = 'character-pack://pack/rive/pack.riv';
    installMascotHost({
      'character.getActivePack': () =>
        packSnapshot({
          source: 'resources',
          id: 'alt',
          mode: 'rive',
          riveUrl: riv,
          staticUrl: null,
          voiceBaseUrl: null,
          hitboxes: null,
          rive: { artboard: 'Alt', stateMachine: 'AltSM' },
        }),
    });
    render(<Nomi2DCanvas manifestPath="./assets/models/sprite/nomi/manifest.json" />);
    const el = await screen.findByTestId('rive-canvas');
    expect(el.getAttribute('data-rive-src')).toBe(riv);
    expect(lastRiveSrc).toBe(riv);
  });
});
