// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureCharacterPackOverlay,
  getCharacterMode,
  getRiveConfig,
  getSpriteManifestPath,
  getStaticSrc,
  isActivePackModel,
  resetCharacterPackOverlayForTest,
  useCharacterPackReady,
} from '../../src/mascot/characterConfig';

function ReadyProbe({ children }: { children: (ready: boolean) => React.ReactNode }) {
  const ready = useCharacterPackReady();
  return <>{children(ready)}</>;
}

function stubGetActive(impl: () => Promise<unknown>): void {
  const w = window as unknown as {
    electronAPI?: { characterPack?: { getActive: () => Promise<unknown> } };
  };
  w.electronAPI = {
    ...(w.electronAPI || {}),
    characterPack: { getActive: impl },
  };
}

function clearStub(): void {
  const w = window as unknown as { electronAPI?: { characterPack?: unknown } };
  if (w.electronAPI) delete w.electronAPI.characterPack;
}

afterEach(() => {
  cleanup();
  resetCharacterPackOverlayForTest();
  clearStub();
});

beforeEach(() => {
  resetCharacterPackOverlayForTest();
  clearStub();
});

describe('Scheme B overlay readiness', () => {
  it('re-renders when overlay settles so mode switches to static', async () => {
    let resolveActive!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveActive = r;
    });
    stubGetActive(() => pending);

    render(
      <ReadyProbe>
        {(ready) => (
          <div data-testid="probe" data-ready={String(ready)} data-mode={getCharacterMode()} />
        )}
      </ReadyProbe>,
    );

    const probe = await screen.findByTestId('probe');
    expect(probe.getAttribute('data-ready')).toBe('false');
    expect(probe.getAttribute('data-mode')).toBe('rive');

    await act(async () => {
      resolveActive({
        source: 'userData',
        id: 'static-demo',
        mode: 'static',
        riveUrl: null,
        staticUrl: 'character-pack://pack/static/character.webp',
        voiceBaseUrl: 'character-pack://pack/voice/zh/',
        hitboxes: null,
        rive: null,
      });
      await pending;
      await ensureCharacterPackOverlay();
    });

    await waitFor(() => {
      const el = screen.getByTestId('probe');
      expect(el.getAttribute('data-ready')).toBe('true');
      expect(el.getAttribute('data-mode')).toBe('static');
    });
    expect(getStaticSrc()).toBe('character-pack://pack/static/character.webp');
  });

  it('exposes overlay riveUrl via getRiveConfig after settle', async () => {
    const riv = 'character-pack://pack/rive/alt.riv';
    stubGetActive(async () => ({
      source: 'resources',
      id: 'alt',
      mode: 'rive',
      riveUrl: riv,
      staticUrl: null,
      voiceBaseUrl: null,
      hitboxes: null,
      rive: { artboard: 'Alt', stateMachine: 'AltSM' },
    }));
    await ensureCharacterPackOverlay();
    const cfg = getRiveConfig();
    expect(cfg.src).toBe(riv);
    expect(cfg.artboard).toBe('Alt');
    expect(cfg.stateMachine).toBe('AltSM');
  });

  it('keeps the built-in model slot active for an overlay with a different id', async () => {
    stubGetActive(async () => ({
      source: 'userData',
      id: 'alt',
      mode: 'rive',
      riveUrl: 'character-pack://pack/rive/character.riv',
      staticUrl: null,
      voiceBaseUrl: 'character-pack://pack/voice/zh/',
      spriteManifestUrl: null,
      hitboxes: null,
      rive: null,
    }));
    await ensureCharacterPackOverlay();
    // model-list.json still names the built-in slot "nomi" at runtime
    expect(isActivePackModel('nomi')).toBe(true);
    expect(isActivePackModel('alt')).toBe(true);
    expect(isActivePackModel('someone-else')).toBe(false);
    expect(isActivePackModel(null)).toBe(false);
  });

  it('uses the overlay sprite manifest only when the pack ships one', async () => {
    const builtin = './assets/models/sprite/nomi/manifest.json';
    expect(getSpriteManifestPath(builtin)).toBe(builtin);
    stubGetActive(async () => ({
      source: 'userData',
      id: 'alt',
      mode: 'sprite',
      riveUrl: null,
      staticUrl: null,
      voiceBaseUrl: null,
      spriteManifestUrl: 'character-pack://pack/sprite/manifest.json',
      hitboxes: null,
      rive: null,
    }));
    await ensureCharacterPackOverlay();
    expect(getSpriteManifestPath(builtin)).toBe('character-pack://pack/sprite/manifest.json');
  });
});
