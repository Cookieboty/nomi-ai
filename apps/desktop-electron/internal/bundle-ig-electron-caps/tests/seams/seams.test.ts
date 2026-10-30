import { describe, expect, it } from 'vitest';

import { AsrKey, ClipboardKey, KeyStoreKey, ScreenKey, TtsKey } from '../../src/seams';

describe('seams exports', () => {
  it('every service key has a distinct symbol', () => {
    const keys = [KeyStoreKey.key, ScreenKey.key, ClipboardKey.key, AsrKey.key, TtsKey.key];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('service key symbols carry readable descriptions', () => {
    expect(KeyStoreKey.key.description).toBe('nomi.ig.service:ctx.keyStore');
    expect(ScreenKey.key.description).toBe('nomi.ig.service:ctx.screen');
    expect(ClipboardKey.key.description).toBe('nomi.ig.service:ctx.clipboard');
    expect(AsrKey.key.description).toBe('nomi.ig.service:ctx.asr');
    expect(TtsKey.key.description).toBe('nomi.ig.service:ctx.tts');
  });

  it('service keys are global symbols: another copy of the package resolves the same key', () => {
    // ESM 与 CommonJS 两份产物各自 defineService 时也要对得上（docs/design/core-host-decoupling.md §12 P4）
    expect(TtsKey.key).toBe(Symbol.for('nomi.ig.service:ctx.tts'));
  });
});
