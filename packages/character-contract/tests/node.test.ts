import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readPackDir, validatePackDir, validatePackDirSync } from '../src/node';

import { legacyRivePack, staticPack } from './fixtures';

const dirs: string[] = [];

function writePack(entries: Record<string, unknown>, sizes: Record<string, number> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'character-contract-'));
  dirs.push(root);
  for (const [rel, value] of Object.entries(entries)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof value === 'string') writeFileSync(abs, value);
    else if (typeof value === 'object' && value !== null) writeFileSync(abs, JSON.stringify(value));
    else writeFileSync(abs, Buffer.alloc(sizes[rel] ?? 4));
  }
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('node entry', () => {
  it('validates a static pack from disk', async () => {
    const res = await validatePackDir(writePack(staticPack()));
    expect(res.errors).toEqual([]);
    expect(res.pack?.persona?.greetings).toEqual(['你好呀']);
  });

  it('reads file sizes and legacy text files', async () => {
    const dir = writePack(legacyRivePack(), { 'rive/character.riv': 4096 });
    const src = await readPackDir(dir);
    expect(src.sizeOf?.('rive/character.riv')).toBe(4096);
    expect(src.readText?.('persona/system-prompt.md')).toContain('你是旧角色');
    const res = await validatePackDir(dir);
    expect(res.ok).toBe(true);
  });

  it('surfaces invalid JSON as json-invalid', async () => {
    const res = await validatePackDir(writePack(staticPack({ 'persona.json': '{ broken' })));
    expect(res.errors.map((e) => [e.code, e.file])).toEqual([['json-invalid', 'persona.json']]);
  });

  it('reports a missing directory', async () => {
    const res = await validatePackDir(join(tmpdir(), 'definitely-not-a-pack-dir-xyz'));
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.code).toBe('manifest-missing');
  });

  it('validates synchronously with the same result', async () => {
    const dir = writePack(staticPack());
    const sync = validatePackDirSync(dir);
    const async_ = await validatePackDir(dir);
    expect(sync.ok).toBe(true);
    expect(sync.pack?.persona).toEqual(async_.pack?.persona);
    expect(validatePackDirSync(join(dir, 'missing')).errors[0]?.code).toBe('manifest-missing');
  });
});

describe('packs in the repository', () => {
  const repo = join(__dirname, '../../..');

  it('official characters/nomi is a valid pack with complete voice', async () => {
    const res = await validatePackDir(join(repo, 'characters/nomi'), {
      requireCompleteVoice: true,
    });
    expect(res.errors).toEqual([]);
    expect(res.pack?.mode).toBe('rive');
    expect(res.pack?.personaSource).toBe('persona.json');
    expect(res.warnings.map((w) => w.code)).not.toContain('locale-key-missing');
  });

  it('characters/test-dummy is a valid static pack', async () => {
    const res = await validatePackDir(join(repo, 'characters/test-dummy'));
    expect(res.errors).toEqual([]);
    expect(res.pack?.mode).toBe('static');
  });
});
