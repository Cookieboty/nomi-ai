jest.unmock('fs');
jest.unmock('path');

import { promises as fsp, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHARACTER_PACK_SCHEME,
  characterPackAssetUrl,
  characterPackMimeFor,
  normalizePackRelPath,
  resolveCharacterPackUrl,
} from '../../../src/character/packProtocol';
import {
  builtinPackCandidates,
  builtinPackDir,
  hitboxesOf,
  loadPackAt,
  resolveCharacterPack,
  validatePackRoot,
} from '../../../src/character/packResolve';

const REPO = path.resolve(__dirname, '../../../../..');
const packOf = (root: string) => {
  const r = loadPackAt(root);
  if (!r.ok) throw new Error(r.reason);
  return r.pack;
};

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
    expect(validatePackRoot(root)).toMatch(/onboarding\/welcome\.webp/);
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

    await fsp.rm(path.join(user, 'onboarding', 'welcome.webp'));
    const b = resolveCharacterPack({ userDataPack: user, resourcesPack: res });
    expect(b.source).toBe('resources');
    expect(b.skipped.some((s) => s.source === 'userData')).toBe(true);

    await fsp.rm(path.join(res, 'manifest.json'));
    const c = resolveCharacterPack({ userDataPack: user, resourcesPack: res });
    expect(c.source).toBe('builtin');
    expect(c.root).toBeNull();

    // the built-in pack goes through the same validation
    const builtin = tmp();
    await writeMinimalStaticPack(builtin, 'builtin-pack');
    const d = resolveCharacterPack({
      userDataPack: user,
      resourcesPack: res,
      builtinPack: builtin,
    });
    expect(d.source).toBe('builtin');
    expect(d.root).toBe(builtin);
    expect(d.manifest?.id).toBe('builtin-pack');
    expect(d.reason).toBe('overlay invalid — using built-in');
    await fsp.rm(path.join(builtin, 'onboarding', 'privacy.webp'));
    const e = resolveCharacterPack({
      userDataPack: user,
      resourcesPack: res,
      builtinPack: builtin,
    });
    expect(e.root).toBeNull();
    expect(e.skipped.some((s) => s.source === 'builtin')).toBe(true);
    await fsp.rm(builtin, { recursive: true, force: true });

    await fsp.rm(user, { recursive: true, force: true });
    await fsp.rm(res, { recursive: true, force: true });
  });

  it('treats a directory without manifest.json as no overlay (packaged placeholder)', async () => {
    const res = tmp();
    writeFileSync(path.join(res, 'README.md'), '# placeholder');
    writeFileSync(path.join(res, '.gitkeep'), '');
    const r = resolveCharacterPack({ userDataPack: path.join(res, 'nope'), resourcesPack: res });
    expect(r.source).toBe('builtin');
    expect(r.skipped).toEqual([]);
    expect(r.reason).toBe('no overlay present');
    await fsp.rm(res, { recursive: true, force: true });
  });

  it('serves the static image that validation accepted (png fallback)', async () => {
    const root = tmp();
    await writeMinimalStaticPack(root);
    await fsp.rm(path.join(root, 'static', 'character.webp'));
    writeFileSync(path.join(root, 'static', 'character.png'), Buffer.from([1]));
    expect(validatePackRoot(root)).toBeNull();
    expect(packOf(root).assets.static).toBe('static/character.png');
    await fsp.rm(path.join(root, 'static', 'character.png'));
    expect(validatePackRoot(root)).toMatch(/static mode requires/);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('reports a sprite manifest only when the pack ships one', async () => {
    const root = tmp();
    await writeMinimalStaticPack(root);
    expect(packOf(root).assets.spriteManifest).toBeNull();
    mkdirSync(path.join(root, 'sprite'), { recursive: true });
    writeFileSync(path.join(root, 'sprite', 'manifest.json'), '{}');
    expect(packOf(root).assets.spriteManifest).toBe('sprite/manifest.json');
    await fsp.rm(root, { recursive: true, force: true });
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
    const hb = hitboxesOf(packOf(root));
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

describe('built-in pack location', () => {
  it('packaged: resources/renderer/character', () => {
    expect(
      builtinPackCandidates({ packaged: true, dev: false, resourcesPath: '/r', appPath: '/a' }),
    ).toEqual([path.join('/r', 'renderer', 'character')]);
  });

  it('unpacked: renderer build output first, then the repository pack', () => {
    const appPath = path.join(REPO, 'packages', 'electron');
    expect(
      builtinPackCandidates({ packaged: false, dev: false, resourcesPath: '', appPath }),
    ).toEqual([
      path.join(appPath, 'dist', 'renderer', 'character'),
      path.join(REPO, 'characters', 'nomi'),
    ]);
    expect(
      builtinPackCandidates({
        packaged: false,
        dev: true,
        resourcesPath: '',
        appPath,
        characterPack: 'characters/test-dummy',
      }),
    ).toEqual([path.join(REPO, 'characters', 'test-dummy')]);
    expect(builtinPackDir({ packaged: false, dev: true, resourcesPath: '', appPath })).toBe(
      path.join(REPO, 'characters', 'nomi'),
    );
  });

  it('the official characters/nomi validates as the built-in pack', () => {
    const r = resolveCharacterPack({
      userDataPack: path.join(os.tmpdir(), 'no-such-user-pack'),
      resourcesPack: path.join(os.tmpdir(), 'no-such-resources-pack'),
      builtinPack: path.join(REPO, 'characters', 'nomi'),
    });
    expect(r.source).toBe('builtin');
    expect(r.manifest?.id).toBe('nomi');
    expect(r.pack?.mode).toBe('rive');
    expect(r.skipped).toEqual([]);
    // as on 2.0.5: no hitboxes, the renderer uses the geometry heuristic
    expect(r.hitboxes).toBeNull();
  });

  it('accepts an overlay that only fails non-structural checks (loaded on 2.0.5)', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'onboarding'), { recursive: true });
    mkdirSync(path.join(root, 'rive'), { recursive: true });
    mkdirSync(path.join(root, 'voice', 'zh'), { recursive: true });
    for (const f of ['welcome.webp', 'profile.webp', 'provider.webp', 'privacy.webp']) {
      writeFileSync(path.join(root, 'onboarding', f), Buffer.from([0]));
    }
    // a placeholder-sized .riv, a declared sprite/ without manifest, voice files without manifest
    writeFileSync(path.join(root, 'rive', 'character.riv'), Buffer.alloc(12, 1));
    writeFileSync(path.join(root, 'voice', 'zh', 'hello.mp3'), Buffer.from([0]));
    writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({ schema: 1, id: 'old-rive', assets: { mode: 'rive', sprite: 'sprite' } }),
    );
    const strict = loadPackAt(root);
    expect(strict.ok).toBe(false);
    const r = resolveCharacterPack({
      userDataPack: root,
      resourcesPack: path.join(os.tmpdir(), 'no-such-resources-pack'),
    });
    expect(r.source).toBe('userData');
    expect(r.skipped).toEqual([]);
    expect(r.downgraded?.join('\n')).toMatch(/rive file too small/);
    expect(r.downgraded?.join('\n')).toMatch(/sprite\/manifest\.json/);
    expect(r.downgraded?.join('\n')).toMatch(/voice\/zh\/manifest\.json/);

    // structural errors still reject the overlay
    await fsp.rm(path.join(root, 'rive', 'character.riv'));
    const missing = resolveCharacterPack({
      userDataPack: root,
      resourcesPack: path.join(os.tmpdir(), 'no-such-resources-pack'),
    });
    expect(missing.root).toBeNull();
    expect(missing.skipped[0]?.reason).toMatch(/missing rive\/character\.riv/);
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

describe('normalizePackRelPath', () => {
  it('strips ./ and backslashes, keeps trailing slash, rejects traversal', () => {
    expect(normalizePackRelPath('./rive/character.riv')).toBe('rive/character.riv');
    expect(normalizePackRelPath('static\\character.webp')).toBe('static/character.webp');
    expect(normalizePackRelPath('voice/zh/')).toBe('voice/zh/');
    expect(normalizePackRelPath('../secret')).toBeNull();
    expect(normalizePackRelPath('/abs')).toBeNull();
    expect(normalizePackRelPath('C:\\abs')).toBeNull();
    expect(characterPackAssetUrl('./onboarding/welcome.webp')).toBe(
      'character-pack://pack/onboarding/welcome.webp',
    );
  });

  it('validates packs whose manifest uses ./ relative asset paths', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'onboarding'), { recursive: true });
    mkdirSync(path.join(root, 'rive'), { recursive: true });
    for (const f of ['welcome.webp', 'profile.webp', 'provider.webp', 'privacy.webp']) {
      writeFileSync(path.join(root, 'onboarding', f), Buffer.from([0]));
    }
    writeFileSync(path.join(root, 'rive', 'character.riv'), Buffer.alloc(2048, 1));
    writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        id: 'dot-rel',
        assets: { mode: 'rive', rive: './rive/character.riv', onboarding: './onboarding' },
      }),
    );
    expect(validatePackRoot(root)).toBeNull();
    await fsp.rm(root, { recursive: true, force: true });
  });
});
