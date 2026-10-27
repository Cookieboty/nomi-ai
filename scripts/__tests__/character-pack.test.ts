import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

function run(script: string, env: Record<string, string> = {}, args: string[] = []) {
  return execFileSync(process.execPath, [join(root, 'scripts/character', script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('character pack scripts', () => {
  it('check passes on examples/nomi.pack', () => {
    const out = run('check.mjs', {}, ['examples/nomi.pack']);
    expect(out).toContain('OK');
  });

  it('check passes on static-demo (skips riv/43)', () => {
    const out = run('check.mjs', {}, ['examples/static-demo.pack']);
    expect(out).toContain('mode=static');
    expect(out).toContain('OK');
  });

  it('apply without CHARACTER_PACK is idempotent no-op for official nomi', () => {
    const out = run('apply.mjs');
    expect(out).toMatch(/already official nomi — no-op|no-op|restored official/);
    const gen = JSON.parse(
      readFileSync(join(root, 'packages/renderer/src/mascot/character.generated.json'), 'utf8'),
    );
    expect(gen.id).toBe('nomi');
    expect(gen.mode).toBe('rive');
    expect(gen.rive.artboard).toBe('Nomi-full');
    expect(gen.rive.stateMachine).toBe('NomiFull');
  });

  it('generated config files exist for renderer and mascot bundle', () => {
    expect(existsSync(join(root, 'packages/renderer/src/mascot/character.generated.json'))).toBe(
      true,
    );
    expect(existsSync(join(root, 'packages/bundle-ig-mascot/src/character.generated.json'))).toBe(
      true,
    );
  });
});
