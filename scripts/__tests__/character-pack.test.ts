import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadPack, modelListFor } from '../character/pack.mjs';
import {
  brandLockModelDir,
  DEFAULT_PACK_DIR,
  DEFAULT_PACK_STATIC_ART,
  selectedPackDir,
} from '../character/paths.mjs';
import { packModuleData, publishedFiles, staticArtModule } from '../character/vite-plugin.mjs';

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

  it('check passes on the test-dummy and the static-demo packs', () => {
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
    expect(
      existsSync(
        join(root, 'apps/desktop-electron/internal/core/src/character/character.generated.json'),
      ),
    ).toBe(false);
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

  it('the official model list matches the one 2.0.5 shipped (only the asset paths moved)', async () => {
    const { pack } = await loadPack(DEFAULT_PACK_DIR);
    expect(modelListFor(pack)).toEqual({
      models: [
        {
          name: 'nomi',
          displayName: 'Nomi·诺米',
          description: 'Nomi·诺米（默认角色，2D 表情立绘）',
          // 2.0.5: ./assets/models/sprite/nomi/{manifest.json,thumb.png}
          path: './character/sprite/manifest.json',
          thumbnail: './character/sprite/thumb.png',
          author: 'Nomi-ai project owner (AI-generated)',
          license: 'MIT',
          source: 'https://github.com/Cookieboty/nomi-ai/blob/main/docs/BRAND.md',
          tags: ['default', 'sprite', '2d', 'soft', 'brand'],
          config: { voice: { voiceHint: 'xiaoxiao', rate: 0.92, pitch: 1.1 } },
        },
      ],
      lastUpdated: '2026-10-13T00:00:00Z',
      version: '3.0.0',
    });
  });

  it('the svg renderer’s static art belongs to the selected pack only (#193)', async () => {
    // 静态包：它自己的立绘
    const dummyDir = join(root, 'characters/test-dummy');
    const { pack: dummy } = await loadPack(dummyDir);
    expect(staticArtModule(dummyDir, dummy)).toBe(
      'export default "./character/static/character.webp";\n',
    );
    // 官方包：它的 SVG 立绘（单独的资源）
    const { pack: official } = await loadPack(DEFAULT_PACK_DIR);
    expect(existsSync(DEFAULT_PACK_STATIC_ART)).toBe(true);
    expect(staticArtModule(DEFAULT_PACK_DIR, official)).toBe(
      `export { default } from ${JSON.stringify(`${DEFAULT_PACK_STATIC_ART.split(sep).join('/')}?url`)};\n`,
    );
    // 其它没有静态立绘的包（这里是官方包的内容放在别的目录）：没有，按包自己的模式渲染
    expect(staticArtModule(join(root, 'characters/other'), official)).toBe(
      'export default null;\n',
    );
  });

  it('the official pack declares no hitboxes (Rive touch uses the geometry heuristic)', async () => {
    const { pack } = await loadPack(DEFAULT_PACK_DIR);
    expect(pack.layout.hitboxes).toBeUndefined();
    expect(pack.layout.bubbleAnchor).toBeUndefined();
    expect(packModuleData(pack).layout.hitboxes).toBeUndefined();
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
    expect(all).toEqual(expect.arrayContaining(['manifest.json', 'sprite/manifest.json']));
    // 远程素材（manifest assets.remote）不进构建：内核按远程角色目录下载
    expect(pack.assets.remote).toEqual(['rive']);
    expect(all).not.toContain('rive/character.riv');
  });
});
