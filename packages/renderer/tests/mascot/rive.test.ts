import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createRiveBackend,
  RIVE_EXPRESSIONS,
  RIVE_MOTION_ALIASES,
  RIVE_POC_MOTIONS,
} from '../../src/mascot/backends/rive';
import { RIVE_FLAG_KEY, isRiveExperimentEnabled } from '../../src/mascot/riveFlag';

/**
 * Production Rive renderer (docs/brand/rive-complete.md) — guard rails:
 *  1. it is OFF unless explicitly opted in,
 *  2. the backend only fires known view-model triggers,
 *  3. SOURCE LOCK: the production scene embeds the supplied full-body mother
 *     and the SVG-backed full-body rig byte-for-byte.
 */
describe('rive experiment flag', () => {
  it('is off by default and only on for ?rive=1 or the localStorage opt-in', () => {
    const empty = { getItem: () => null };
    expect(isRiveExperimentEnabled('', empty)).toBe(false);
    expect(isRiveExperimentEnabled('?rive=0', empty)).toBe(false);
    expect(isRiveExperimentEnabled('?rive=1', empty)).toBe(true);
    expect(isRiveExperimentEnabled('?rive=full', empty)).toBe(true);
    expect(
      isRiveExperimentEnabled('', { getItem: (k) => (k === RIVE_FLAG_KEY ? '1' : null) }),
    ).toBe(true);
    expect(isRiveExperimentEnabled('', null)).toBe(false);
  });
});

describe('rive backend', () => {
  it('fires the matching trigger and rejects unknown motions', () => {
    const fire = vi.fn();
    const trigger = vi.fn((name: string) => ({ trigger: () => fire(name) }));
    const b = createRiveBackend(() => ({ trigger }));
    expect(b.kind).toBe('rive');
    expect(b.playMotion('wave')).toBe(true);
    expect(fire).toHaveBeenCalledWith('wave');
    expect(b.playMotion('moonwalk')).toBe(false);
    expect(b.capabilities().motions).toEqual([...RIVE_POC_MOTIONS]);
  });

  it('is a no-op while the Rive instance is not ready', () => {
    const b = createRiveBackend(() => null);
    expect(b.playMotion('wave')).toBe(false);
  });

  it('routes every shared AI gesture to an authored native clip', () => {
    const fire = vi.fn();
    const b = createRiveBackend(() => ({
      trigger: (name) => ({ trigger: () => fire(name) }),
    }));
    for (const [alias, native] of Object.entries(RIVE_MOTION_ALIASES)) {
      expect(b.playMotion(alias), alias).toBe(true);
      expect(fire).toHaveBeenLastCalledWith(native);
    }
  });

  it('drives expression, talking, and thresholded lip-sync triggers', () => {
    const fired: string[] = [];
    const b = createRiveBackend(() => ({
      trigger: (name) => ({ trigger: () => fired.push(name) }),
    }));
    b.setExpression('happy');
    b.setExpression('happy'); // no duplicate trigger while the expression is held
    b.setMouthOpen(0.5);
    b.setMouthOpen(0.6); // thresholded, does not spam a trigger every audio frame
    b.setTalking(true);
    b.setTalking(false);
    expect(fired).toEqual(['expr-happy', 'mouth-open', 'talking', 'mouth-close']);
    expect(b.capabilities().expressions).toEqual([...RIVE_EXPRESSIONS]);
    expect(b.capabilities().lipSync).toBe(true);
  });
});

const RIV = path.join(__dirname, '../../public/assets/models/rive/nomi-complete.riv');
const REPO = path.join(__dirname, '../../../..');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from('IEND');

/** every PNG stream embedded in a .riv (signature … IEND chunk + CRC) */
function embeddedPngs(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const s = buf.indexOf(PNG_SIG, at);
    if (s < 0) return out;
    const e = buf.indexOf(IEND, s);
    if (e < 0) return out;
    out.push(buf.subarray(s, e + 8));
    at = e + 8;
  }
}

describe('source lock: production Rive scene', () => {
  it('embeds the supplied full-body mother byte for byte', () => {
    const pngs = embeddedPngs(fs.readFileSync(RIV));
    expect(pngs.length).toBeGreaterThanOrEqual(7);
    const embedded = new Set(pngs.map((p) => createHash('sha256').update(p).digest('hex')));
    for (const file of ['rive/nomi-complete/source-nomi-master.png']) {
      const hash = createHash('sha256').update(fs.readFileSync(path.join(REPO, file))).digest('hex');
      expect(embedded.has(hash), file).toBe(true);
    }
  });

  it('embeds the full-body mother SVG byte-for-byte', () => {
    const riv = fs.readFileSync(RIV);
    const svg = fs.readFileSync(path.join(REPO, 'rive/nomi-complete/reference/svg-rig/nomi-fullbody-mother.svg'));
    expect(riv.includes(svg)).toBe(true);
  });
});
