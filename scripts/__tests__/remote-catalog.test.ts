import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCatalog } from '../character/remote-catalog.mjs';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'remote-catalog-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('remote character catalog (characters-publish)', () => {
  it('lists the official pack’s remote rive with its content hash', async () => {
    const { catalog, files } = await buildCatalog({ baseUrl: 'https://x.test/c' });
    const sha = createHash('sha256')
      .update(readFileSync(repoPath('characters/nomi/rive/character.riv')))
      .digest('hex');
    expect(catalog.packs).toEqual([
      expect.objectContaining({
        id: 'nomi',
        assets: {
          rive: expect.objectContaining({
            file: `nomi-rive-${sha.slice(0, 12)}.riv`,
            url: `https://x.test/c/nomi-rive-${sha.slice(0, 12)}.riv`,
            sha256: sha,
          }),
        },
      }),
    ]);
    expect(files).toHaveLength(1);
  });

  it('fails on a Git LFS pointer instead of publishing an empty catalog', async () => {
    const root = tmp();
    cpSync(repoPath('characters/nomi'), join(root, 'nomi'), { recursive: true });
    writeFileSync(
      join(root, 'nomi/rive/character.riv'),
      'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 16368864\n',
    );
    await expect(buildCatalog({ charactersDir: root })).rejects.toThrow();
  });

  it('fails on a broken pack, skips directories that are not packs', async () => {
    const root = tmp();
    mkdirSync(join(root, 'notes'));
    expect((await buildCatalog({ charactersDir: root })).catalog.packs).toEqual([]);
    mkdirSync(join(root, 'broken'));
    writeFileSync(join(root, 'broken/manifest.json'), '{ not json');
    await expect(buildCatalog({ charactersDir: root })).rejects.toThrow();
  });
});
