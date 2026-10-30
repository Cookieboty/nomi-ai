// @vitest-environment happy-dom
/**
 * 桌面角色窗口 → avatar-runtime 的适配（Nomi2DCanvas）：等 Scheme B 覆盖包就绪后，把当前角色
 * （模式、资源、Rive 画板、命中区）、事件中枢、窗口宿主与互动输出交给 AvatarStage。
 * 渲染器的选择与 Rive 失败回退在 avatar-runtime 的 avatarCanvas 测试里。
 */
import type { AvatarRuntimeOptions } from '@nomi-ai/avatar-runtime';
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { avatarEvents } from '../../src/avatar/events';
import { Nomi2DCanvas } from '../../src/components/Mascot/Nomi2DCanvas';
import { BUNDLED_PACK, resetCharacterPackOverlayForTest } from '../../src/mascot/characterConfig';

import { installMascotHost, packSnapshot, resetMascotHost } from './mascotHost';

vi.mock('../../src/services/api', async () => (await import('./mascotHost')).mascotApiModule());

const h = vi.hoisted(() => ({ last: null as AvatarRuntimeOptions | null }));

vi.mock('@nomi-ai/avatar-runtime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  AvatarStage: (props: AvatarRuntimeOptions) => {
    h.last = props;
    return <div data-testid="avatar-stage" data-mode={props.character.mode} />;
  },
}));

const url = (path: string | null | undefined): string => {
  const p = h.last;
  if (!p || !path) return '';
  return /^(?:[a-z][a-z0-9+.-]*:|\.{0,2}\/)/i.test(path) ? path : p.resolveAsset(path);
};

afterEach(() => {
  cleanup();
  h.last = null;
  resetCharacterPackOverlayForTest();
  resetMascotHost();
});

beforeEach(() => {
  resetCharacterPackOverlayForTest();
});

describe('Nomi2DCanvas → AvatarStage', () => {
  it('without a transport: the bundled pack, the window event hub, no window host', async () => {
    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    await screen.findByTestId('avatar-stage');
    const p = h.last!;
    expect(p.character.id).toBe(BUNDLED_PACK.id);
    expect(p.character.mode).toBe(BUNDLED_PACK.mode);
    expect(url(p.character.assets.rive)).toBe(
      BUNDLED_PACK.assets.rive ? `${BUNDLED_PACK.base}${BUNDLED_PACK.assets.rive}` : '',
    );
    expect(p.character.assets.spriteManifest).toBe('./character/sprite/manifest.json');
    expect(p.events).toBe(avatarEvents);
    expect(p.windowHost).toBeNull();
    expect(typeof p.onInteraction).toBe('function');
    expect(p.riveWasmUrl).toBeTruthy();
  });

  it('waits for the overlay, then passes the overlay static image', async () => {
    let resolveActive!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveActive = r;
    });
    installMascotHost({
      'character.getActivePack': async () =>
        packSnapshot((await pending) as Record<string, unknown>),
    });

    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    expect(screen.queryByTestId('avatar-stage')).toBeNull();

    await act(async () => {
      resolveActive({
        source: 'userData',
        id: 'static-demo',
        mode: 'static',
        staticUrl: 'character-pack://pack/static/character.webp',
        hitboxes: { regions: { head: { top: 0, bottom: 0.4, left: 0.2, right: 0.8 } } },
      });
      await pending;
    });

    const el = await screen.findByTestId('avatar-stage');
    expect(el.getAttribute('data-mode')).toBe('static');
    const p = h.last!;
    expect(p.character.id).toBe('static-demo');
    expect(url(p.character.assets.static)).toBe('character-pack://pack/static/character.webp');
    expect(p.character.layout).toEqual({
      hitboxes: { head: { top: 0, bottom: 0.4, left: 0.2, right: 0.8 } },
    });
    // 有契约传输：窗口宿主经契约报告命中 / 拖拽
    expect(p.windowHost).not.toBeNull();
  });

  it('official pack, renderer svg (default): static mode with the official pack’s own SVG art', async () => {
    installMascotHost({
      'mascot.getRenderer': () => 'svg',
      'character.getActivePack': () =>
        packSnapshot({ source: 'builtin', id: BUNDLED_PACK.id, mode: BUNDLED_PACK.mode }),
    });
    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    await screen.findByTestId('avatar-stage');
    const p = h.last!;
    expect(p.character.id).toBe(BUNDLED_PACK.id);
    expect(p.character.mode).toBe('static');
    // 测试按官方包构建（CHARACTER_PACK 未设置）：立绘来自构建插件给官方包的 SVG
    const art = (await import('virtual:character-static-art')).default;
    expect(art).toMatch(/nomi-fullbody-mother\.svg/);
    expect(url(p.character.assets.static)).toBe(art);
  });

  it('official pack, renderer rive: the bundled .riv, no static art', async () => {
    installMascotHost({
      'mascot.getRenderer': () => 'rive',
      'character.getActivePack': () =>
        packSnapshot({ source: 'builtin', id: BUNDLED_PACK.id, mode: BUNDLED_PACK.mode }),
    });
    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    await screen.findByTestId('avatar-stage');
    const p = h.last!;
    expect(p.character.mode).toBe(BUNDLED_PACK.mode);
    expect(url(p.character.assets.rive)).toBe(`${BUNDLED_PACK.base}${BUNDLED_PACK.assets.rive}`);
    expect(p.character.assets.static).toBeNull();
  });

  it('Scheme B overlay on svg: the overlay’s own image, never the bundled pack’s art', async () => {
    installMascotHost({
      'mascot.getRenderer': () => 'svg',
      'character.getActivePack': () =>
        packSnapshot({
          source: 'userData',
          id: 'static-demo',
          mode: 'static',
          staticUrl: 'character-pack://pack/static/character.webp',
        }),
    });
    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    await screen.findByTestId('avatar-stage');
    const p = h.last!;
    expect(p.character.mode).toBe('static');
    expect(url(p.character.assets.static)).toBe('character-pack://pack/static/character.webp');
  });

  it('overlay: passes its declared expressions with its mapping (2.0.5-template check, #192)', async () => {
    const mapping = { emotions: { neutral: 'neutral', sad: 'tears' }, gestures: { wave: 'w2' } };
    installMascotHost({
      'character.getActivePack': () =>
        packSnapshot({
          source: 'userData',
          id: 'tears-pack',
          mode: 'static',
          staticUrl: 'character-pack://pack/static/character.webp',
          mapping,
          expressions: ['neutral', 'tears'],
        }),
    });
    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    await screen.findByTestId('avatar-stage');
    const p = h.last!;
    expect(p.character.mapping).toEqual(mapping);
    expect(p.character.capabilities).toEqual({ expressions: ['neutral', 'tears'] });
  });

  it('bundled pack: passes the pack’s capabilities with its mapping', async () => {
    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    await screen.findByTestId('avatar-stage');
    expect(h.last!.character.capabilities).toBe(BUNDLED_PACK.capabilities);
    expect(h.last!.character.mapping).toBe(BUNDLED_PACK.mapping);
  });

  it('passes the overlay .riv and its artboard / state machine', async () => {
    const riv = 'character-pack://pack/rive/pack.riv';
    installMascotHost({
      'character.getActivePack': () =>
        packSnapshot({
          source: 'resources',
          id: 'alt',
          mode: 'rive',
          riveUrl: riv,
          rive: { artboard: 'Alt', stateMachine: 'AltSM' },
        }),
    });
    render(<Nomi2DCanvas manifestPath="./character/sprite/manifest.json" />);
    await screen.findByTestId('avatar-stage');
    const p = h.last!;
    expect(url(p.character.assets.rive)).toBe(riv);
    expect(p.character.rive).toEqual({ artboard: 'Alt', stateMachine: 'AltSM' });
    expect(p.character.layout).toBeNull();
  });
});
