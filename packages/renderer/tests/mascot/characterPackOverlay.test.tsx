// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureCharacterPackOverlay,
  getCharacterMode,
  getRiveConfig,
  getStaticSrc,
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
});
