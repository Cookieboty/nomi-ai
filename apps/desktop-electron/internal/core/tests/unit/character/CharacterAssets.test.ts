jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { NormalizedPack } from '@nomi-ai/character-contract';

import { CharacterAssets, type CharacterAssetsState } from '../../../src/character/CharacterAssets';
import { resolveCharacterAssetUrl } from '../../../src/character/packProtocol';

const CATALOG = 'https://example.test/characters/catalog.json';

const pack = (remote: string[] = ['rive']) =>
  ({
    manifest: { id: 'nomi' },
    assets: { rive: 'rive/character.riv', remote },
  }) as unknown as NormalizedPack;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** 假的远程角色目录：files 里是可下载的素材 */
function remote(files: Record<string, Buffer>, rive: string) {
  const urls: string[] = [];
  let offline = false;
  let corrupt = false;
  const fetchImpl = jest.fn(async (url: string) => {
    urls.push(url);
    if (offline) throw new TypeError('fetch failed');
    if (url === CATALOG) {
      const b = files[rive]!;
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          packs: [
            {
              id: 'nomi',
              version: '1.0.0',
              assets: {
                rive: {
                  file: rive,
                  url: `https://example.test/characters/${rive}`,
                  size: b.length,
                  sha256: sha(b),
                },
              },
            },
          ],
        }),
      );
    }
    const name = url.split('/').pop()!;
    const b = files[name];
    if (!b) return new Response('nope', { status: 404 });
    return new Response(new Uint8Array(corrupt ? Buffer.alloc(b.length, 1) : b));
  });
  return {
    fetchImpl,
    urls,
    goOffline: () => (offline = true),
    corrupt: () => (corrupt = true),
    setRive: (r: string) => (rive = r),
  };
}

describe('CharacterAssets', () => {
  let root: string;
  let events: CharacterAssetsState[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'char-assets-'));
    events = [];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = (r: ReturnType<typeof remote>, p: NormalizedPack | null = pack()) =>
    new CharacterAssets({
      root,
      activePack: () => p,
      publish: (s) => events.push(s),
      fetchImpl: r.fetchImpl,
      catalogUrl: CATALOG,
    });

  const v1 = Buffer.from('rive v1 '.repeat(4000));
  const v2 = Buffer.from('rive v2 '.repeat(5000));

  it('downloads the remote rive on first ensure, then serves it from the cache', async () => {
    const r = remote({ 'nomi-rive-aaa.riv': v1 }, 'nomi-rive-aaa.riv');
    const a = make(r);
    expect(a.state()).toEqual({ packId: 'nomi', remote: true, status: 'idle' });
    const s = await a.ensure();
    expect(s).toMatchObject({
      packId: 'nomi',
      remote: true,
      status: 'ready',
      version: sha(v1).slice(0, 12),
      riveUrl: 'character-pack://assets/nomi/nomi-rive-aaa.riv',
    });
    expect(fs.readFileSync(path.join(root, 'nomi', 'nomi-rive-aaa.riv'))).toEqual(v1);
    expect(events.map((e) => e.status)).toEqual(
      expect.arrayContaining(['checking', 'downloading', 'ready']),
    );
    expect(events.some((e) => e.status === 'downloading' && e.percent === 100)).toBe(true);

    // 新实例（下次启动）：直接就绪；同一版本只读目录、不再下载
    const b = make(r);
    expect(b.state().status).toBe('ready');
    r.urls.length = 0;
    await b.ensure();
    expect(r.urls).toEqual([CATALOG]);
  });

  it('a new version replaces the old file; the old one stays usable while downloading', async () => {
    const r = remote({ 'nomi-rive-aaa.riv': v1, 'nomi-rive-bbb.riv': v2 }, 'nomi-rive-aaa.riv');
    const a = make(r);
    await a.ensure();
    r.setRive('nomi-rive-bbb.riv');
    events.length = 0;
    const s = await a.ensure();
    expect(s.riveUrl).toBe('character-pack://assets/nomi/nomi-rive-bbb.riv');
    expect(events.every((e) => e.status === 'ready')).toBe(true);
    expect(fs.readdirSync(path.join(root, 'nomi')).sort()).toEqual([
      'current.json',
      'nomi-rive-bbb.riv',
    ]);
  });

  it('rejects a download whose sha256 does not match and keeps nothing', async () => {
    const r = remote({ 'nomi-rive-aaa.riv': v1 }, 'nomi-rive-aaa.riv');
    r.corrupt();
    const s = await make(r).ensure();
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/sha256/);
    expect(fs.readdirSync(path.join(root, 'nomi'))).toEqual([]);
  });

  it('offline: keeps the cached asset; without a cache reports an error to retry', async () => {
    const r = remote({ 'nomi-rive-aaa.riv': v1 }, 'nomi-rive-aaa.riv');
    await make(r).ensure();
    r.goOffline();
    expect((await make(r).ensure()).status).toBe('ready');

    fs.rmSync(path.join(root, 'nomi'), { recursive: true });
    const s = await make(r).ensure();
    expect(s).toMatchObject({ status: 'error', remote: true });
    expect(s.riveUrl).toBeUndefined();
  });

  it('a pack without remote assets needs nothing', async () => {
    const r = remote({ 'nomi-rive-aaa.riv': v1 }, 'nomi-rive-aaa.riv');
    const a = make(r, pack([]));
    expect(await a.ensure()).toEqual({ packId: 'nomi', remote: false, status: 'idle' });
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });

  it('a stalled download fails instead of hanging', async () => {
    const a = new CharacterAssets({
      root,
      activePack: () => pack(),
      publish: () => undefined,
      catalogUrl: CATALOG,
      stallMs: 50,
      fetchImpl: async (url, init) => {
        if (url === CATALOG) {
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              packs: [
                {
                  id: 'nomi',
                  assets: {
                    rive: {
                      file: 'x.riv',
                      url: 'https://example.test/x.riv',
                      size: 10,
                      sha256: 'a'.repeat(64),
                    },
                  },
                },
              ],
            }),
          );
        }
        return new Promise<Response>((_, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        );
      },
    });
    const s = await a.ensure();
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/stalled/);
  });

  it('protocol: character-pack://assets/… resolves inside the cache root only', async () => {
    fs.mkdirSync(path.join(root, 'nomi'));
    fs.writeFileSync(path.join(root, 'nomi', 'a.riv'), 'x');
    // native：与 fsp.realpath 一致（Windows 上展开短文件名，如 RUNNER~1）
    const real = fs.realpathSync.native(path.join(root, 'nomi', 'a.riv'));
    expect(await resolveCharacterAssetUrl(root, 'character-pack://assets/nomi/a.riv')).toBe(real);
    expect(await resolveCharacterAssetUrl(root, 'character-pack://pack/nomi/a.riv')).toBeNull();
    expect(
      await resolveCharacterAssetUrl(root, 'character-pack://assets/../etc/passwd'),
    ).toBeNull();
    expect(
      await resolveCharacterAssetUrl(root, 'character-pack://assets/nomi/%2e%2e/x'),
    ).toBeNull();
    expect(await resolveCharacterAssetUrl(null, 'character-pack://assets/nomi/a.riv')).toBeNull();
  });
});
