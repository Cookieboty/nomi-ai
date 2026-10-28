// @vitest-environment happy-dom
import { applyLocale } from '@nomi-ai/ui';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureCharacterPackOverlay,
  BUNDLED_PACK,
  getCharacterMode,
  getHitboxes,
  getRiveConfig,
  getSpriteManifestPath,
  getStaticSrc,
  isActivePackModel,
  resetCharacterPackOverlayForTest,
  useCharacterPackReady,
} from '../../src/mascot/characterConfig';
import { availableLines, characterLine, characterName } from '../../src/mascot/characterCopy';

import { installMascotHost, packSnapshot, resetMascotHost } from './mascotHost';

vi.mock('../../src/services/api', async () => (await import('./mascotHost')).mascotApiModule());

function ReadyProbe({ children }: { children: (ready: boolean) => React.ReactNode }) {
  const ready = useCharacterPackReady();
  return <>{children(ready)}</>;
}

/** 契约 character.getActivePack（快照缺的字段按空值补齐） */
function stubGetActive(impl: () => Promise<unknown>): void {
  installMascotHost({
    'character.getActivePack': async () => packSnapshot((await impl()) as Record<string, unknown>),
  });
}

function clearStub(): void {
  resetMascotHost();
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

describe('bundled pack', () => {
  it('yields no hitboxes, so touch keeps the geometry heuristic (as on 2.0.5)', async () => {
    expect(BUNDLED_PACK.layout.hitboxes).toBeUndefined();
    expect(getHitboxes()).toBeNull();
    await ensureCharacterPackOverlay(); // no Electron bridge → stays on the bundled pack
    expect(getHitboxes()).toBeNull();
  });
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

  it('reads character copy from the overlay pack only (no fallback to the bundled lines)', async () => {
    expect(characterLine('greet-welcome-back')).toBeTruthy();
    stubGetActive(async () => ({
      source: 'userData',
      id: 'test-dummy',
      mode: 'static',
      riveUrl: null,
      staticUrl: 'character-pack://pack/static/character.webp',
      voiceBaseUrl: null,
      spriteManifestUrl: null,
      hitboxes: null,
      rive: null,
      locales: { zh: { lines: { 'greet-welcome-back': '哔哔，欢迎回来。' } } },
    }));
    await ensureCharacterPackOverlay();
    expect(characterLine('greet-welcome-back')).toBe('哔哔，欢迎回来。');
    expect(characterLine('tip-ask-me-anything')).toBeUndefined();
    expect(availableLines(['tip-ask-me-anything', 'greet-welcome-back'])).toEqual([
      'greet-welcome-back',
    ]);
  });

  it('names the figure after the active character, never the official one (§10.1)', async () => {
    // 内置包（这次构建打进去的包）的人设名
    expect(characterName()).toBe(BUNDLED_PACK.persona?.displayName);
    stubGetActive(async () => ({
      source: 'userData',
      id: 'test-dummy',
      mode: 'static',
      displayName: { zh: '小纸', en: 'Pip' },
      riveUrl: null,
      staticUrl: 'character-pack://pack/static/character.webp',
      voiceBaseUrl: null,
      spriteManifestUrl: null,
      hitboxes: null,
      rive: null,
    }));
    await ensureCharacterPackOverlay();
    expect(characterName()).toBe('小纸');
    applyLocale('en');
    expect(characterName()).toBe('Pip');
    applyLocale('zh-CN');
  });
});
