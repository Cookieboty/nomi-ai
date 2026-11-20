import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { parseDevArgs, resolveGoBuildConfig } from '../../apps/desktop-go/dev.mjs';

describe('dev script configuration', () => {
  it('parses dev flags and forwards remaining args', () => {
    expect(parseDevArgs([])).toEqual({ skipDeps: false, prod: false, appArgs: [] });
    expect(parseDevArgs(['--prod'])).toEqual({ skipDeps: false, prod: true, appArgs: [] });
    expect(parseDevArgs(['--prod', '--skip-deps', '--foo', 'bar'])).toEqual({
      skipDeps: true,
      prod: true,
      appArgs: ['--foo', 'bar'],
    });
    expect(parseDevArgs(['--prod', '--', '--skip-deps', '--prod'])).toEqual({
      skipDeps: false,
      prod: true,
      appArgs: ['--skip-deps', '--prod'],
    });
  });

  it('resolves Go build tags and output names for dev vs prod profiles', () => {
    expect(resolveGoBuildConfig({ platform: 'darwin', prod: false })).toEqual({
      tags: 'nomi_dev,private_mac_apis',
      binName: 'nomi-dev',
      nextBinName: 'nomi-dev.next',
    });
    expect(resolveGoBuildConfig({ platform: 'darwin', prod: true })).toEqual({
      tags: 'private_mac_apis',
      binName: 'nomi',
      nextBinName: 'nomi.next',
    });

    expect(resolveGoBuildConfig({ platform: 'linux', prod: false })).toEqual({
      tags: 'nomi_dev,gtk3',
      binName: 'nomi-dev',
      nextBinName: 'nomi-dev.next',
    });
    expect(resolveGoBuildConfig({ platform: 'linux', prod: true })).toEqual({
      tags: 'gtk3',
      binName: 'nomi',
      nextBinName: 'nomi.next',
    });

    expect(resolveGoBuildConfig({ platform: 'win32', prod: false })).toEqual({
      tags: 'nomi_dev',
      binName: 'nomi-dev.exe',
      nextBinName: 'nomi-dev.next.exe',
    });
    expect(resolveGoBuildConfig({ platform: 'win32', prod: true })).toEqual({
      tags: '',
      binName: 'nomi.exe',
      nextBinName: 'nomi.next.exe',
    });
  });

  it('defines pnpm dev:prod in root package.json', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.dev).toContain('apps/desktop-go/dev.mjs');
    expect(pkg.scripts.dev).not.toContain('--prod');
    expect(pkg.scripts['dev:prod']).toContain('scripts/doctor.mjs --quick');
    expect(pkg.scripts['dev:prod']).toContain('apps/desktop-go/dev.mjs --prod');
  });
});
