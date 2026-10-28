import { describe, expect, it } from 'vitest';

import {
  isContractVersionSupported,
  joinPackPath,
  migrateHitboxIds,
  migrateLegacyCopy,
  migrateLegacyHitboxesFile,
  migrateLegacyPersona,
  migrateManifest,
  migrateVoiceClipIds,
  normalizePackPath,
  resolveLine,
  resolvePersona,
  resolveVoiceClipId,
  VOICE_IDS,
} from '../src';

describe('migrateHitboxIds (skirt → hem)', () => {
  it('renames skirt to hem without mutating input', () => {
    const input = { head: 1, skirt: 2 };
    expect(migrateHitboxIds(input)).toEqual({ head: 1, hem: 2 });
    expect(input).toEqual({ head: 1, skirt: 2 });
  });

  it('keeps hem when both are present', () => {
    expect(migrateHitboxIds({ hem: 'new', skirt: 'old' })).toEqual({ hem: 'new' });
  });

  it('passes through non-objects', () => {
    expect(migrateHitboxIds(null)).toBeNull();
    expect(migrateLegacyHitboxesFile({ nope: 1 })).toBeUndefined();
  });
});

describe('voice key alias', () => {
  it('maps legacy i18n keys to stable ids and leaves stable ids alone', () => {
    expect(resolveVoiceClipId('ui.cli-monitor.hi-i-m-nomi')).toBe('greet-hello');
    expect(resolveVoiceClipId('greet-hello')).toBe('greet-hello');
    expect(resolveVoiceClipId('unknown-key')).toBe('unknown-key');
    expect(migrateVoiceClipIds(['ui.cli-monitor.hi-i-m-nomi', 'greet-hello'])).toEqual([
      'greet-hello',
    ]);
  });

  it('byId and byLegacyKey are inverse tables', () => {
    for (const [legacy, id] of Object.entries(VOICE_IDS.byLegacyKey)) {
      expect(VOICE_IDS.byId[id]).toBe(legacy);
    }
  });
});

describe('migrateManifest', () => {
  it('adds contractVersion, moves top-level mode, merges legacy hitboxes', () => {
    const raw = { schema: 1, id: 'x', mode: 'sprite', engines: { nomiPack: '>=1 <2' } };
    const out = migrateManifest(raw, {
      legacyHitboxes: { regions: { skirt: { top: 0 } }, bubbleAnchor: { x: 1, y: 0 } },
    });
    expect(out).toEqual({
      schema: 1,
      id: 'x',
      contractVersion: 1,
      engines: { nomiPack: '>=1 <2' },
      assets: { mode: 'sprite' },
      layout: { hitboxes: { hem: { top: 0 } }, bubbleAnchor: { x: 1, y: 0 } },
    });
    expect(raw).toHaveProperty('mode', 'sprite');
  });

  it('prefers manifest.layout over the legacy file and keeps explicit versions', () => {
    const out = migrateManifest(
      { contractVersion: 1, assets: { mode: 'rive' }, layout: { hitboxes: { skirt: 'a' } } },
      { legacyHitboxes: { regions: { head: 'b' } } },
    ) as Record<string, unknown>;
    expect(out.layout).toEqual({ hitboxes: { hem: 'a' } });
    expect(out.contractVersion).toBe(1);
  });

  it('passes non-objects through for the schema to reject', () => {
    expect(migrateManifest('nope')).toBe('nope');
  });
});

describe('legacy copy / persona', () => {
  it('copy/<lang>.json → locales/<lang>.json', () => {
    expect(
      migrateLegacyCopy({
        displayName: 'A',
        wakePhrase: 'Hi A',
        systemPromptIdentity: 'You are A',
      }),
    ).toEqual({
      persona: { displayName: 'A', systemPromptIdentity: 'You are A' },
      wakePhrase: 'Hi A',
    });
    expect(migrateLegacyCopy(null)).toEqual({});
  });

  it('derives persona from copy first, then system-prompt.md, then manifest', () => {
    expect(
      migrateLegacyPersona({
        manifest: { id: 'a', displayName: { zh: '甲', en: 'A' } },
        systemPrompt: '\n你是甲。\n第二行',
      }),
    ).toEqual({ displayName: '甲', systemPromptIdentity: '你是甲。', greetings: [] });
    expect(migrateLegacyPersona({ manifest: { id: 'a' } })).toBeNull();
  });
});

describe('copy resolution', () => {
  const persona = { displayName: '甲', systemPromptIdentity: '你是甲。', greetings: ['嗨'] };
  const locales = {
    zh: { lines: { 'greet-hello': '你好', only: '仅中文' } },
    en: { persona: { displayName: 'A' }, lines: { 'greet-hello': 'Hello' } },
  };

  it('resolvePersona applies locale overrides', () => {
    expect(resolvePersona(persona, locales, 'en-US').displayName).toBe('A');
    expect(resolvePersona(persona, locales, 'zh').displayName).toBe('甲');
  });

  it('resolveLine falls back to the primary locale and resolves legacy keys', () => {
    expect(resolveLine(locales, 'greet-hello', 'en')).toBe('Hello');
    expect(resolveLine(locales, 'ui.cli-monitor.hi-i-m-nomi', 'en')).toBe('Hello');
    expect(resolveLine(locales, 'only', 'en')).toBe('仅中文');
    expect(resolveLine(locales, 'missing', 'en')).toBeUndefined();
  });
});

describe('paths & versions', () => {
  it('normalizes safe relative paths and rejects escapes', () => {
    expect(normalizePackPath('./sprite/')).toBe('sprite');
    expect(normalizePackPath('voice\\zh\\a.mp3')).toBe('voice/zh/a.mp3');
    expect(normalizePackPath('../x')).toBeNull();
    expect(normalizePackPath('/etc/passwd')).toBeNull();
    expect(normalizePackPath('C:/x')).toBeNull();
    expect(normalizePackPath('')).toBeNull();
    expect(joinPackPath('static', 'character.webp')).toBe('static/character.webp');
  });

  it('supports contract versions up to the current one', () => {
    expect(isContractVersionSupported(1)).toBe(true);
    expect(isContractVersionSupported(2)).toBe(false);
    expect(isContractVersionSupported(0)).toBe(false);
  });
});
