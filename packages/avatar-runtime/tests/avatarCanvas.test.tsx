// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvatarCanvas } from '../src/canvas/AvatarCanvas';
import type { AvatarCharacter } from '../src/host';

let riveFailure: ((reason: string) => void) | undefined;
let lastRive: { src?: string; artboard?: string; stateMachine?: string } | undefined;
let lastStaticSrc: string | undefined;

vi.mock('../src/canvas/RiveCanvas', () => ({
  default: (p: {
    onFailure?: (reason: string) => void;
    src?: string;
    artboard?: string;
    stateMachine?: string;
  }) => {
    riveFailure = p.onFailure;
    lastRive = { src: p.src, artboard: p.artboard, stateMachine: p.stateMachine };
    return <div data-testid="rive-canvas" data-rive-src={p.src ?? ''} />;
  },
}));
vi.mock('../src/canvas/SpriteCanvas', () => ({
  default: ({ manifestPath }: { manifestPath: string }) => (
    <div data-testid="sprite-canvas" data-manifest={manifestPath} />
  ),
}));
vi.mock('../src/canvas/StaticCanvas', () => ({
  default: ({ src }: { src?: string }) => {
    lastStaticSrc = src;
    return <div data-testid="static-canvas" data-static-src={src ?? ''} />;
  },
}));

const resolveAsset = (p: string) => `./character/${p}`;

const character = (patch: Partial<AvatarCharacter> = {}): AvatarCharacter => ({
  id: 'demo',
  mode: 'rive',
  assets: {
    rive: 'rive/character.riv',
    spriteManifest: 'sprite/manifest.json',
    static: null,
  },
  rive: { artboard: 'Main', stateMachine: 'SM' },
  ...patch,
});

afterEach(() => {
  cleanup();
  riveFailure = undefined;
  lastRive = undefined;
  lastStaticSrc = undefined;
  delete document.documentElement.dataset.mascotRenderer;
});

describe('AvatarCanvas', () => {
  it('renders Rive by default with the resolved .riv and the manifest artboard', async () => {
    render(<AvatarCanvas character={character()} resolveAsset={resolveAsset} />);
    await screen.findByTestId('rive-canvas');
    expect(screen.queryByTestId('sprite-canvas')).toBeNull();
    expect(document.documentElement.dataset.mascotRenderer).toBeUndefined();
    expect(lastRive).toEqual({
      src: './character/rive/character.riv',
      artboard: 'Main',
      stateMachine: 'SM',
    });
  });

  it('falls back to the static image when Rive reports a failure and the pack has one', async () => {
    render(
      <AvatarCanvas
        character={character({
          assets: {
            rive: 'rive/character.riv',
            spriteManifest: null,
            static: 'character-pack://pack/static/character.svg',
          },
        })}
        resolveAsset={resolveAsset}
      />,
    );
    await screen.findByTestId('rive-canvas');
    React.act(() => riveFailure?.('Rive load failed'));
    const el = await screen.findByTestId('static-canvas');
    expect(el.getAttribute('data-static-src')).toBe('character-pack://pack/static/character.svg');
    expect(screen.queryByTestId('sprite-canvas')).toBeNull();
    expect(document.documentElement.dataset.mascotRenderer).toBe('static-fallback');
  });

  it('without a static image falls back to the layered 2D renderer', async () => {
    render(<AvatarCanvas character={character()} resolveAsset={resolveAsset} />);
    await screen.findByTestId('rive-canvas');
    React.act(() => riveFailure?.('Rive load failed'));
    const sprite = await screen.findByTestId('sprite-canvas');
    expect(sprite.getAttribute('data-manifest')).toBe('./character/sprite/manifest.json');
    await waitFor(() => expect(screen.queryByTestId('rive-canvas')).toBeNull());
    expect(document.documentElement.dataset.mascotRenderer).toBe('sprite-fallback');
  });

  it('static mode paints the static image; absolute URLs are used as given', async () => {
    render(
      <AvatarCanvas
        character={character({
          mode: 'static',
          assets: { static: 'character-pack://pack/static/character.webp' },
        })}
        resolveAsset={resolveAsset}
      />,
    );
    const el = await screen.findByTestId('static-canvas');
    expect(el.getAttribute('data-static-src')).toBe('character-pack://pack/static/character.webp');
    expect(lastStaticSrc).toBe('character-pack://pack/static/character.webp');
    expect(screen.queryByTestId('rive-canvas')).toBeNull();
  });

  it('sprite mode skips Rive', async () => {
    render(<AvatarCanvas character={character({ mode: 'sprite' })} resolveAsset={resolveAsset} />);
    const el = await screen.findByTestId('sprite-canvas');
    expect(el.getAttribute('data-manifest')).toBe('./character/sprite/manifest.json');
    expect(screen.queryByTestId('rive-canvas')).toBeNull();
  });
});
