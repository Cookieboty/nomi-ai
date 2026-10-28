import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadPack, modelListFor } from '../character/pack.mjs';
import { brandLockModelDir, DEFAULT_PACK_DIR, selectedPackDir } from '../character/paths.mjs';
import { packModuleData, publishedFiles } from '../character/vite-plugin.mjs';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

function run(script: string, env: Record<string, string> = {}, args: string[] = []) {
  return execFileSync(process.execPath, [join(root, 'scripts/character', script), ...args], {
    cwd: root,
    env: { ...process.env, CHARACTER_PACK: '', ...env },
    encoding: 'utf8',
  });
}

describe('character pack scripts', () => {
  it('check passes on the official pack characters/nomi (default)', () => {
    const out = run('check.mjs');
    expect(out).toContain('characters/nomi');
    expect(out).toContain('OK');
  });

  it('check passes on the test-dummy and the legacy static-demo packs', () => {
    expect(run('check.mjs', {}, ['characters/test-dummy'])).toContain('mode=static');
    const out = run('check.mjs', {}, ['examples/static-demo.pack']);
    expect(out).toContain('mode=static');
    expect(out).toContain('OK');
  });

  it('apply only validates the selected pack and writes nothing', () => {
    expect(run('apply.mjs')).toMatch(/characters\/nomi id=nomi mode=rive/);
    expect(run('apply.mjs', { CHARACTER_PACK: 'characters/test-dummy' })).toMatch(
      /id=test-dummy mode=static/,
    );
    expect(existsSync(join(root, 'packages/renderer/src/mascot/character.generated.json'))).toBe(
      false,
    );
    expect(existsSync(join(root, 'packages/electron/src/character/character.generated.json'))).toBe(
      false,
    );
  });

  it('init scaffolds a valid pack from the test-dummy template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'character-init-'));
    const target = join(dir, 'my-pack');
    try {
      run('init.mjs', {}, [target, 'my-pack']);
      expect(JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).id).toBe('my-pack');
      expect(run('check.mjs', {}, [target])).toContain('OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pack selection and build data', () => {
  it('defaults to characters/nomi and honours CHARACTER_PACK', () => {
    expect(selectedPackDir({})).toBe(DEFAULT_PACK_DIR);
    expect(selectedPackDir({ CHARACTER_PACK: 'characters/test-dummy' })).toBe(
      join(root, 'characters/test-dummy'),
    );
    expect(() => selectedPackDir({ CHARACTER_PACK: 'characters/nope' })).toThrow(/not found/);
    expect(brandLockModelDir({})).toBe(join(DEFAULT_PACK_DIR, 'sprite'));
  });

  it('the official persona is read from the pack (identity only, one per language)', async () => {
    const { pack } = await loadPack(DEFAULT_PACK_DIR);
    expect(pack.persona.systemPromptIdentity).toContain('Nomi');
    expect(pack.persona.systemPromptIdentity).not.toContain('简洁');
    expect(pack.locales.en.persona.systemPromptIdentity).toMatch(/^You are Nomi/);
  });

  it('renderer data and model list come from the selected pack', async () => {
    const { pack } = await loadPack(join(root, 'characters/test-dummy'));
    const data = packModuleData(pack);
    expect(data).toMatchObject({ id: 'test-dummy', mode: 'static', base: './character/' });
    expect(data.assets.static).toBe('static/character.webp');
    const list = modelListFor(pack);
    expect(list.models).toHaveLength(1);
    expect(list.models[0]).toMatchObject({ name: 'test-dummy', displayName: 'Pip·小纸' });
    expect(JSON.stringify(list)).not.toMatch(/Nomi|诺米/);
  });

  it('ai-chat ships only the onboarding illustrations at a fixed path', async () => {
    const { pack } = await loadPack(DEFAULT_PACK_DIR);
    expect(publishedFiles(DEFAULT_PACK_DIR, pack, 'onboarding')).toEqual([
      ['onboarding/welcome.webp', 'onboarding/welcome.webp'],
      ['onboarding/profile.webp', 'onboarding/profile.webp'],
      ['onboarding/provider.webp', 'onboarding/provider.webp'],
      ['onboarding/privacy.webp', 'onboarding/privacy.webp'],
    ]);
    const all = publishedFiles(DEFAULT_PACK_DIR, pack, 'all').map(([src]) => src);
    expect(all).toEqual(expect.arrayContaining(['manifest.json', 'rive/character.riv']));
  });
});
