jest.unmock('fs');
jest.unmock('path');

import { promises as fsp, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHARACTER_PACK_SCHEME,
  characterPackAssetUrl,
  characterPackMimeFor,
  resolveCharacterPackUrl,
} from '../../../src/character/packProtocol';
import {
  resolveCharacterPack,
  validatePackRoot,
  loadHitboxes,
} from '../../../src/character/packResolve';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'char-pack-'));

async function writeMinimalStaticPack(root: string, id = 'demo') {
  mkdirSync(path.join(root, 'onboarding'), { recursive: true });
  mkdirSync(path.join(root, 'static'), { recursive: true });
  mkdirSync(path.join(root, 'layout'), { recursive: true });
  for (const f of ['welcome.webp', 'profile.webp', 'provider.webp', 'privacy.webp']) {
    writeFileSync(path.join(root, 'onboarding', f), Buffer.from([0]));
  }
  writeFileSync(path.join(root, 'static', 'character.webp'), Buffer.from([1, 2, 3]));
  writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schema: 1,
      id,
      displayName: { zh: '示范', en: 'Demo' },
      assets: { mode: 'static' },
    }),
  );
  writeFileSync(
    path.join(root, 'layout', 'hitboxes.json'),
    JSON.stringify({
      regions: {
        head: { top: 0, bottom: 0.3, left: 0.2, right: 0.8 },
        hem: { top: 0.6, bottom: 1, left: 0.15, right: 0.85 },
      },
      bubbleAnchor: { x: 0.5, y: 0.12 },
    }),
  );
}

describe('validatePackRoot', () => {
  it('accepts a minimal static pack and rejects missing onboarding', async () => {
    const root = tmp();
    await writeMinimalStaticPack(root);
    expect(validatePackRoot(root)).toBeNull();
    await fsp.rm(path.join(root, 'onboarding', 'welcome.webp'));
    expect(validatePackRoot(root)).toMatch(/missing onboarding/);
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe('resolveCharacterPack', () => {
  it('prefers userData over resources, falls back to builtin on invalid', async () => {
    const user = tmp();
    const res = tmp();
    await writeMinimalStaticPack(user, 'user-pack');
    await writeMinimalStaticPack(res, 'res-pack');
    const a = resolveCharacterPack({ userDataPack: user, resourcesPack: res });
    expect(a.source).toBe('userData');
    expect(a.manifest?.id).toBe('user-pack');
    expect(a.hitboxes?.regions.hem).toBeTruthy();
    expect(a.hitboxes?.bubbleAnchor?.y).toBe(0.12);

    await fsp.rm(path.join(user, 'manifest.json'));
    const b = resolveCharacterPack({ userDataPack: user, resourcesPack: res });
    expect(b.source).toBe('resources');
    expect(b.skipped.some((s) => s.source === 'userData')).toBe(true);

    await fsp.rm(path.join(res, 'manifest.json'));
    const c = resolveCharacterPack({ userDataPack: user, resourcesPack: res });
    expect(c.source).toBe('builtin');
    expect(c.root).toBeNull();

    await fsp.rm(user, { recursive: true, force: true });
    await fsp.rm(res, { recursive: true, force: true });
  });

  it('normalizes legacy skirt region to hem', async () => {
    const root = tmp();
    await writeMinimalStaticPack(root);
    writeFileSync(
      path.join(root, 'layout', 'hitboxes.json'),
      JSON.stringify({
        regions: { skirt: { top: 0.7, bottom: 1, left: 0.2, right: 0.8 } },
      }),
    );
    const hb = loadHitboxes(root, { schema: 1, id: 'x' });
    expect(hb?.regions.hem).toEqual({ top: 0.7, bottom: 1, left: 0.2, right: 0.8 });
    expect(hb?.regions.skirt).toBeUndefined();
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe('character-pack protocol helpers', () => {
  it('builds asset URLs and mime types', () => {
    expect(CHARACTER_PACK_SCHEME).toBe('character-pack');
    expect(characterPackAssetUrl('onboarding/welcome.webp')).toBe(
      'character-pack://pack/onboarding/welcome.webp',
    );
    expect(characterPackMimeFor('a.webp')).toBe('image/webp');
    expect(characterPackMimeFor('a.mp3')).toBe('audio/mpeg');
    expect(characterPackMimeFor('a.riv')).toBe('application/octet-stream');
  });

  it('resolves in-root files and rejects traversal', async () => {
    const root = tmp();
    await writeMinimalStaticPack(root);
    const ok = await resolveCharacterPackUrl(root, 'character-pack://pack/onboarding/welcome.webp');
    expect(ok).toBe(await fsp.realpath(path.join(root, 'onboarding', 'welcome.webp')));
    expect(await resolveCharacterPackUrl(root, 'character-pack://pack/../secret.webp')).toBeNull();
    expect(await resolveCharacterPackUrl(null, 'character-pack://pack/x.webp')).toBeNull();
    expect(
      await resolveCharacterPackUrl(root, 'character-pack://other/onboarding/welcome.webp'),
    ).toBeNull();
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe('real example pack (Scheme B fixture)', () => {
  it('loads examples/static-demo.pack as userData overlay', () => {
    const pack = path.resolve(__dirname, '../../../../../examples/static-demo.pack');
    expect(validatePackRoot(pack)).toBeNull();
    const r = resolveCharacterPack({
      userDataPack: pack,
      resourcesPack: path.join(os.tmpdir(), 'no-such-resources-pack'),
    });
    expect(r.source).toBe('userData');
    expect(r.manifest?.id).toBe('static-demo');
    expect(r.hitboxes?.regions.hem).toBeTruthy();
    expect(r.hitboxes?.bubbleAnchor).toBeTruthy();
  });
});
