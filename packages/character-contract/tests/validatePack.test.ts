import { describe, expect, it } from 'vitest';

import { createPackSource, validatePack, type PackIssue } from '../src';

import { legacyRivePack, ONBOARDING, staticPack } from './fixtures';

const codes = (issues: PackIssue[]) => issues.map((i) => i.code);

describe('validatePack — new-shape static pack', () => {
  it('passes and returns the normalized pack', () => {
    const res = validatePack(createPackSource(staticPack()));
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.pack?.mode).toBe('static');
    expect(res.pack?.assets.static).toBe('static/character.webp');
    expect(res.pack?.persona?.displayName).toBe('替身');
    expect(res.pack?.personaSource).toBe('persona.json');
    expect(res.pack?.layout.window).toEqual({ width: 320, height: 480 });
    expect(res.pack?.locales.en?.wakePhrase).toBe('Hi, Dummy');
    expect(res.pack?.mapping?.activities?.thinking).toEqual(['nod']);
    // static 包没有语音只警告
    expect(codes(res.warnings)).toContain('voice-not-provided');
    expect(codes(res.warnings)).not.toContain('persona-missing');
  });

  it('reports missing onboarding art and static image as errors', () => {
    const entries = staticPack();
    delete entries['onboarding/privacy.webp'];
    delete entries['static/character.webp'];
    const res = validatePack(createPackSource(entries));
    expect(res.ok).toBe(false);
    expect(res.pack).toBeNull();
    expect(res.errors.map((e) => [e.code, e.file])).toEqual(
      expect.arrayContaining([
        ['onboarding-missing', 'onboarding/privacy.webp'],
        ['asset-missing', 'static/character.webp'],
      ]),
    );
  });

  it('falls back to static/character.png', () => {
    const entries = staticPack();
    delete entries['static/character.webp'];
    entries['static/character.png'] = true;
    const res = validatePack(createPackSource(entries));
    expect(res.ok).toBe(true);
    expect(res.pack?.assets.static).toBe('static/character.png');
  });

  it('returns structured schema errors with field paths', () => {
    const res = validatePack(
      createPackSource(
        staticPack({
          'persona.json': { displayName: '', greetings: 'hi' },
        }),
      ),
    );
    expect(res.ok).toBe(false);
    const persona = res.errors.filter((e) => e.file === 'persona.json');
    expect(persona.every((e) => e.code === 'schema-invalid')).toBe(true);
    expect(persona.map((e) => e.path[0]).sort()).toEqual([
      'displayName',
      'greetings',
      'systemPromptIdentity',
    ]);
  });

  it('rejects bad manifest fields and unsafe paths', () => {
    const base = staticPack()['manifest.json'] as Record<string, unknown>;
    const res = validatePack(
      createPackSource(
        staticPack({
          'manifest.json': {
            ...base,
            id: 'Bad Id',
            assets: { mode: 'gif', static: '../outside.webp' },
            layout: { hitboxes: { head: { top: 0.5, bottom: 0.2, left: 0, right: 1 } } },
          },
        }),
      ),
    );
    expect(res.ok).toBe(false);
    const paths = res.errors.map((e) => e.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['id', 'assets.mode', 'assets.static', 'layout.hitboxes.head']),
    );
  });

  it('rejects a newer contractVersion', () => {
    const base = staticPack()['manifest.json'] as Record<string, unknown>;
    const res = validatePack(
      createPackSource(staticPack({ 'manifest.json': { ...base, contractVersion: 99 } })),
    );
    expect(codes(res.errors)).toEqual(['contract-version-unsupported']);
  });

  it('reports missing manifest and invalid JSON', () => {
    expect(codes(validatePack(createPackSource({ ...ONBOARDING })).errors)).toEqual([
      'manifest-missing',
    ]);
    const res = validatePack(createPackSource(staticPack({ 'mapping.json': '{ nope' })));
    expect(res.errors.map((e) => [e.code, e.file])).toEqual([['json-invalid', 'mapping.json']]);
  });

  it('warns on unknown semantic names and undeclared mapping targets', () => {
    const res = validatePack(
      createPackSource(
        staticPack({
          'mapping.json': {
            emotions: { ecstatic: 'happy', happy: 'backflip' },
            gestures: { wave: 'wave', nod: 'headbang', random: 'random' },
          },
        }),
      ),
    );
    expect(res.ok).toBe(true);
    const mapping = res.warnings.filter((w) => w.file === 'mapping.json');
    expect(mapping.map((w) => [w.code, w.path.join('.')])).toEqual([
      ['mapping-unknown-semantic', 'emotions.ecstatic'],
      ['mapping-target-undeclared', 'emotions.happy'],
      ['mapping-target-undeclared', 'gestures.nod'],
    ]);
  });

  it('ignores a 2.0.5-template mapping.json with a warning (engine default mapping)', () => {
    const res = validatePack(
      createPackSource(
        staticPack({
          'mapping.json': {
            emotions: { happy: 'nod', sad: 'tears', shy: 'shy', confused: 'puzzled' },
            gestures: { wave: 'wave', apologize: ['apology', 'sorry'] },
          },
        }),
      ),
    );
    expect(res.ok).toBe(true);
    expect(res.pack?.mapping).toBeNull();
    const mapping = res.warnings.filter((w) => w.file === 'mapping.json');
    expect(mapping.map((w) => [w.code, w.path.join('.')])).toEqual([
      ['mapping-legacy', 'emotions'],
    ]);
  });

  it('warns when en lines miss keys present in zh', () => {
    const res = validatePack(
      createPackSource(staticPack({ 'locales/en.json': { lines: { 'greet-hello': 'Hello!' } } })),
    );
    const w = res.warnings.find((x) => x.code === 'locale-key-missing');
    expect(w?.file).toBe('locales/en.json');
    expect(w?.message).toContain('tip-ask-me-anything');
  });

  it('warns on empty greetings', () => {
    const res = validatePack(
      createPackSource(
        staticPack({
          'persona.json': { displayName: 'X', systemPromptIdentity: 'You are X.', greetings: [] },
        }),
      ),
    );
    expect(res.ok).toBe(true);
    expect(codes(res.warnings)).toContain('persona-greetings-empty');
  });
});

describe('validatePack — legacy rive pack', () => {
  it('migrates manifest, hitboxes, copy and persona', () => {
    const res = validatePack(createPackSource(legacyRivePack(), { 'rive/character.riv': 50_000 }));
    expect(res.errors).toEqual([]);
    const pack = res.pack!;
    expect(pack.manifest.contractVersion).toBe(1);
    expect(pack.mode).toBe('rive');
    expect(pack.assets.rive).toBe('rive/character.riv');
    expect(pack.assets.spriteManifest).toBe('sprite/manifest.json');
    expect(Object.keys(pack.layout.hitboxes ?? {}).sort()).toEqual(['head', 'hem']);
    expect(pack.layout.bubbleAnchor).toEqual({ x: 0.72, y: 0.18 });
    expect(pack.manifest.capabilities?.voiceClipIds).toEqual(['greet-hello']);
    expect(pack.personaSource).toBe('legacy');
    expect(pack.persona).toEqual({
      displayName: '旧角色',
      systemPromptIdentity: '你是旧角色。',
      greetings: [],
    });
    expect(pack.locales.zh).toEqual({
      persona: { displayName: '旧角色', systemPromptIdentity: '你是旧角色。' },
      wakePhrase: '你好，旧角色',
    });
    expect(codes(res.warnings)).toEqual(
      expect.arrayContaining(['layout-legacy', 'locale-legacy', 'persona-legacy']),
    );
  });

  it('flags a placeholder-sized rive file', () => {
    const res = validatePack(createPackSource(legacyRivePack(), { 'rive/character.riv': 12 }));
    expect(codes(res.errors)).toEqual(['asset-too-small']);
  });

  it('voice completeness is an error only when required', () => {
    const entries = legacyRivePack();
    entries['voice/zh/manifest.json'] = {
      clips: [{ id: 'greet-hello', file: 'greet-hello.mp3' }, { key: 'ui.cli-monitor.task-done' }],
    };
    const lenient = validatePack(createPackSource(entries));
    expect(lenient.ok).toBe(true);
    expect(codes(lenient.warnings)).toContain('voice-clips-incomplete');
    const strict = validatePack(createPackSource(entries), { requireCompleteVoice: true });
    expect(codes(strict.errors)).toEqual(['voice-clips-incomplete']);
  });

  it('lenient mode downgrades non-structural errors to warnings', () => {
    const entries = legacyRivePack();
    delete entries['voice/zh/manifest.json'];
    const sizes = { 'rive/character.riv': 12 };
    const strict = validatePack(createPackSource(entries, sizes));
    expect(codes(strict.errors).sort()).toEqual(['asset-too-small', 'voice-manifest-missing']);
    const lenient = validatePack(createPackSource(entries, sizes), { lenient: true });
    expect(lenient.ok).toBe(true);
    expect(lenient.pack).not.toBeNull();
    expect(codes(lenient.warnings)).toEqual(
      expect.arrayContaining(['asset-too-small', 'voice-manifest-missing']),
    );
    // structural errors stay errors
    delete entries['onboarding/welcome.webp'];
    const broken = validatePack(createPackSource(entries, sizes), { lenient: true });
    expect(codes(broken.errors)).toEqual(['onboarding-missing']);
  });

  it('a missing fallback asset (not the main mode) has its own code', () => {
    const entries = legacyRivePack();
    delete entries['sprite/manifest.json'];
    const base = entries['manifest.json'] as Record<string, unknown>;
    entries['manifest.json'] = { ...base, assets: { mode: 'rive', sprite: 'sprite' } };
    const res = validatePack(createPackSource(entries));
    expect(codes(res.errors)).toEqual(['fallback-asset-missing']);
    expect(validatePack(createPackSource(entries), { lenient: true }).ok).toBe(true);
  });

  it('requires voice/zh/manifest.json when voice/zh has files', () => {
    const entries = legacyRivePack();
    delete entries['voice/zh/manifest.json'];
    expect(codes(validatePack(createPackSource(entries)).errors)).toEqual([
      'voice-manifest-missing',
    ]);
  });

  it('requires the rive file in rive mode and recommends a sprite fallback', () => {
    const entries = legacyRivePack();
    delete entries['rive/character.riv'];
    const base = entries['manifest.json'] as Record<string, unknown>;
    entries['manifest.json'] = { ...base, assets: { mode: 'rive' } };
    delete entries['sprite/manifest.json'];
    const res = validatePack(createPackSource(entries));
    expect(res.errors.map((e) => [e.code, e.file])).toEqual([
      ['asset-missing', 'rive/character.riv'],
    ]);
    expect(codes(res.warnings)).toContain('sprite-fallback-recommended');
  });
});
