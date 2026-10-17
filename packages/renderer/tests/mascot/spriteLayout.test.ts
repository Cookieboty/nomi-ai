import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MASCOT_SCALE,
  MASCOT_PAD as MAIN_PAD,
  mascotWindowSize,
  migrateMascotSize,
} from '../../../electron/src/mascot/mascotSize';
import { intersects, placeBubble } from '../../src/mascot/bubblePlacement';
import {
  rigBodyBox,
  rigHeadBox,
  rigTransform,
  type RigImages,
  type RigManifest,
} from '../../src/mascot/layeredRig';
import { regionInSprite } from '../../src/mascot/spriteInteraction';
import { characterBox, MASCOT_PAD } from '../../src/mascot/spriteLayout';

const dir = new URL('../../public/assets/models/sprite/nomi/', import.meta.url);
const rig = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')).rig as RigManifest;
const imgs: RigImages = new Map();
for (const f of readdirSync(new URL('layers/', dir))) {
  if (!f.endsWith('.png')) continue;
  const b = readFileSync(new URL(`layers/${f}`, dir));
  const fake = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  imgs.set(f.slice(0, -4), fake as unknown as CanvasImageSource & typeof fake);
}

describe('mascot size (half-size default)', () => {
  it('renderer pads match the main process', () => {
    expect(MASCOT_PAD).toEqual(MAIN_PAD);
  });

  it('default window is half the old character size plus slim margins', () => {
    expect(DEFAULT_MASCOT_SCALE).toBe(0.5);
    expect(mascotWindowSize(0.5)).toEqual({ width: 330, height: 355 });
    // the character box is exactly half of the old 420×450 window
    const cb = characterBox(330, 355);
    expect([cb.w, cb.h]).toEqual([210, 225]);
    // far smaller window area than before (fewer transparent pixels to hit-test)
    expect(330 * 355).toBeLessThan(420 * 450 * 0.65);
  });

  it('migrates pre-scale configs to the half-size default, keeping the bottom-centre anchor', () => {
    const m = migrateMascotSize({ windowPosition: { x: 1000, y: 500 } });
    expect(m).toMatchObject({ mascotScale: 0.5, migrated: true });
    // old window bottom-centre (1210, 950) == new window bottom-centre
    expect(m.windowPosition!.x + 330 / 2).toBe(1000 + 210);
    expect(m.windowPosition!.y + 355).toBe(500 + 450);
    expect(migrateMascotSize({ mascotScale: 0.8 })).toMatchObject({
      mascotScale: 0.8,
      migrated: false,
    });
    expect(migrateMascotSize({ mascotScale: 9 }).mascotScale).toBe(1.5);
    expect(migrateMascotSize(null)).toMatchObject({ mascotScale: 0.5, migrated: false });
  });
});

describe('sprite geometry + bubble', () => {
  const view = { width: 330, height: 355 };
  const v = rigTransform(rig, view.width, view.height, characterBox(view.width, view.height));
  const head = rigHeadBox(rig, imgs, null, v)!;
  const body = rigBodyBox(rig, imgs, v, view.width, view.height)!;

  it('head box sits on the upper part of the figure inside the character box', () => {
    expect(head.top).toBeGreaterThanOrEqual(MASCOT_PAD.top - 12);
    expect(head.bottom).toBeLessThan(view.height * 0.7);
    expect(head.left).toBeGreaterThan(body.left - 10);
    expect(head.right).toBeLessThan(body.right + 10);
    expect(body.bottom).toBeLessThanOrEqual(view.height);
  });

  it('bubble is above / beside the head, never over the face, for short and long text', () => {
    for (const lines of [1, 2, 4, 8]) {
      for (const winX of [0, 400, 1590]) {
        const p = placeBubble({
          head,
          view,
          measure: () => 22 * lines + 16,
          preferAbove: true,
          screen: { winX, availLeft: 0, availWidth: 1920 },
          gutter: { left: body.right + 12, right: body.right + 48, top: 150, bottom: 300 },
        });
        const r = { left: p.x, top: p.y, right: p.x + p.width, bottom: p.y + p.height };
        expect(intersects(r, head)).toBe(false);
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.right).toBeLessThanOrEqual(view.width);
        expect(r.top).toBeGreaterThanOrEqual(0);
        expect(['above', 'left', 'right']).toContain(p.candidate);
      }
    }
  });

  it('head box follows the pose (lean / bob)', () => {
    const moved = rigHeadBox(
      rig,
      imgs,
      { headX: 20, headY: -10, bodyY: 0, torsoX: 0, figureScale: 1 },
      v,
    )!;
    expect(moved.left - head.left).toBeCloseTo(20 * v.sc, 3);
    expect(moved.top - head.top).toBeCloseTo(-10 * v.sc, 3);
  });

  it('maps points to body regions', () => {
    const cx = (head.left + head.right) / 2;
    expect(regionInSprite(cx, head.top + 2, head, body)).toBe('head');
    expect(regionInSprite(cx, head.bottom - 4, head, body)).toBe('face');
    expect(regionInSprite(cx, head.bottom + 10, head, body)).toBe('body');
    expect(regionInSprite(body.left + 2, head.bottom + 30, head, body)).toBe('hands');
    expect(regionInSprite(cx, body.bottom - 2, head, body)).toBe('skirt');
  });
});

describe('layout at every supported scale (0.3–1.5)', () => {
  for (const scale of [0.3, 0.5, 1, 1.5]) {
    it(`scale ${scale}: character box is exactly BASE·scale, bubble never covers the face`, () => {
      const win = mascotWindowSize(scale);
      const cb = characterBox(win.width, win.height);
      expect([cb.x, cb.y]).toEqual([MASCOT_PAD.x, MASCOT_PAD.top]);
      expect(Math.abs(cb.w - 420 * scale)).toBeLessThanOrEqual(1);
      expect(Math.abs(cb.h - 450 * scale)).toBeLessThanOrEqual(1);
      const v = rigTransform(rig, win.width, win.height, cb);
      const head = rigHeadBox(rig, imgs, null, v)!;
      const body = rigBodyBox(rig, imgs, v, win.width, win.height)!;
      // the figure stays inside the window and its feet at (or above) the bottom edge
      expect(body.bottom).toBeLessThanOrEqual(win.height);
      expect(body.left).toBeGreaterThanOrEqual(0);
      expect(body.right).toBeLessThanOrEqual(win.width);
      for (const lines of [1, 3, 6]) {
        for (const winX of [0, 700, 1700 - win.width]) {
          const p = placeBubble({
            head,
            view: win,
            measure: () => 22 * lines + 16,
            preferAbove: true,
            screen: { winX, availLeft: 0, availWidth: 1920 },
            gutter: { left: body.right + 12, right: body.right + 48, top: 150, bottom: 300 },
          });
          const r = { left: p.x, top: p.y, right: p.x + p.width, bottom: p.y + p.height };
          expect(intersects(r, head)).toBe(false);
          expect(r.left).toBeGreaterThanOrEqual(0);
          expect(r.right).toBeLessThanOrEqual(win.width);
          expect(r.top).toBeGreaterThanOrEqual(0);
        }
      }
    });
  }
});
