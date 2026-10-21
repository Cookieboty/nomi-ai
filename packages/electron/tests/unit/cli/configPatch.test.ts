jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { isAllowedUpdateArgv, updateRecipes } from '../../../src/cli/CliUpdateService';
import {
  DSH_MARK_BEGIN,
  GROK_MARK_BEGIN,
  GROK_KEY_ENV,
  GrokInlineModelsError,
  patchDshYaml,
  patchGrokToml,
  backupFile,
  patchClaudeSettings,
  patchCodexAuth,
  patchCodexToml,
} from '../../../src/cli/configPatch';

describe('configPatch', () => {
  it('patches claude settings env only', () => {
    const raw = JSON.stringify(
      { env: { FOO: '1', ANTHROPIC_API_KEY: 'old' }, permissions: { allow: ['Bash'] } },
      null,
      2,
    );
    const next = JSON.parse(
      patchClaudeSettings(raw, {
        ANTHROPIC_API_KEY: 'new-key',
        ANTHROPIC_BASE_URL: 'https://example.com',
      }),
    );
    expect(next.env.ANTHROPIC_API_KEY).toBe('new-key');
    expect(next.env.ANTHROPIC_BASE_URL).toBe('https://example.com');
    expect(next.env.FOO).toBe('1');
    expect(next.permissions.allow).toEqual(['Bash']);
  });

  it('patches codex toml model + provider', () => {
    const raw = 'model = "gpt-4"\nother = 1\n';
    const out = patchCodexToml(raw, {
      model: 'gpt-test',
      model_provider: 'nomi',
      base_url: 'http://127.0.0.1:11434/v1',
    });
    expect(out).toContain('model = "gpt-test"');
    expect(out).toContain('[model_providers.nomi]');
    expect(out).toContain('base_url = "http://127.0.0.1:11434/v1"');
    expect(out).toContain('wire_api = "responses"');
    expect(out).toContain('other = 1');
  });

  it('re-patching codex toml keeps a single provider table', () => {
    const patch = { model: 'm1', model_provider: 'nomi', base_url: 'http://a/v1' };
    const once = patchCodexToml('model = "x"\n[profiles.p]\nmodel = "y"\n', patch);
    const twice = patchCodexToml(once, { ...patch, model: 'm2', base_url: 'http://b/v1' });
    expect(twice.match(/^\[model_providers\.nomi\]$/gm)).toHaveLength(1);
    expect(twice.match(/^base_url = /gm)).toHaveLength(1);
    expect(twice).toContain('base_url = "http://b/v1"');
    expect(twice).toContain('name = "nomi"');
    expect(twice).toContain('model = "m2"');
    // 其它表保持原样
    expect(twice).toContain('[profiles.p]\nmodel = "y"');
  });

  it('patches auth.json', () => {
    const out = JSON.parse(patchCodexAuth(null, 'sk-test'));
    expect(out.OPENAI_API_KEY).toBe('sk-test');
  });

  it('backupFile copies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-bak-'));
    const src = path.join(dir, 'a.json');
    fs.writeFileSync(src, '{"a":1}');
    const dest = backupFile(src, path.join(dir, 'b'), 'a.json');
    expect(dest).toBeTruthy();
    expect(fs.readFileSync(dest!, 'utf8')).toBe('{"a":1}');
  });
});

describe('update whitelist', () => {
  it('allows only known argv', () => {
    expect(isAllowedUpdateArgv(['claude', 'update'])).toBe(true);
    expect(isAllowedUpdateArgv(['codex', 'update'])).toBe(true);
    expect(isAllowedUpdateArgv(['grok', 'update'])).toBe(true);
    expect(isAllowedUpdateArgv(['npm', 'install', '-g', '@anthropic-ai/claude-code@latest'])).toBe(
      true,
    );
    expect(isAllowedUpdateArgv(['npm', 'install', '-g', '@xai-official/grok@latest'])).toBe(true);
    expect(isAllowedUpdateArgv(['npm', 'install', '-g', 'evil'])).toBe(false);
    expect(isAllowedUpdateArgv(['bash', '-c', 'rm -rf /'])).toBe(false);
  });

  it('recipes prefer self update then npm', () => {
    const r = updateRecipes('claude', '/usr/bin/claude', 'native');
    expect(r[0]!.argv).toEqual(['/usr/bin/claude', 'update']);
    expect(isAllowedUpdateArgv(r[0]!.argv)).toBe(true);
  });
});

describe('dsh update recipe', () => {
  it('only uses npm global install (no self-update)', () => {
    const g = updateRecipes('gemini', '/usr/local/bin/gemini', 'unknown');
    // Gemini 没有 `gemini update`，只走 npm
    expect(g.map((x) => x.via)).toEqual(['npm']);
    expect(g[0]!.argv.slice(1)).toEqual(['install', '-g', '@google/gemini-cli@latest']);
    expect(isAllowedUpdateArgv(g[0]!.argv)).toBe(true);
    const r = updateRecipes('dsh', '/usr/local/bin/dsh', 'unknown');
    expect(r).toHaveLength(1);
    expect(r[0]!.via).toBe('npm');
    expect(r[0]!.argv.slice(1)).toEqual(['install', '-g', '@deepseek-ai/dsh@latest']);
    expect(isAllowedUpdateArgv(r[0]!.argv)).toBe(true);
  });
  it('rejects dsh update and extra npm args', () => {
    expect(isAllowedUpdateArgv(['dsh', 'update'])).toBe(false);
    expect(
      isAllowedUpdateArgv(['npm', 'install', '-g', '@deepseek-ai/dsh@latest', '--prefix=/x']),
    ).toBe(false);
  });
});

describe('patchDshYaml', () => {
  const patch = { api: 'openai-completions', baseURL: 'http://h/v1', model: 'm:1' };
  it('creates the managed block in an empty file', () => {
    const out = patchDshYaml(null, patch);
    expect(out.startsWith(DSH_MARK_BEGIN)).toBe(true);
    expect(out).toContain('apiKeyEnv: NOMI_DSH_API_KEY');
    expect(out).toContain('baseURL: "http://h/v1"');
    expect(out).toContain('- id: agent-default-model');
  });
  it('replaces an existing block and keeps user content', () => {
    const first = patchDshYaml('- id: mine\n', patch);
    const second = patchDshYaml(first, { ...patch, model: 'other' });
    expect(second.match(/nomi managed/g)).toHaveLength(2);
    expect(second).toContain('- id: mine');
    expect(second).toContain('model: "other"');
    expect(second).not.toContain('"m:1"');
  });
  it('removes only the block', () => {
    expect(patchDshYaml(patchDshYaml('- id: mine\n', patch), null)).toBe('- id: mine\n');
    expect(patchDshYaml(patchDshYaml(null, patch), null)).toBe('');
  });
});

describe('grok update recipe', () => {
  it('prefers grok update then npm', () => {
    const r = updateRecipes('grok', '/usr/local/bin/grok', 'native');
    expect(r[0]!.via).toBe('self');
    expect(r[0]!.argv).toEqual(['/usr/local/bin/grok', 'update']);
    expect(isAllowedUpdateArgv(r[0]!.argv)).toBe(true);
    expect(r[1]!.via).toBe('npm');
    expect(r[1]!.argv.slice(1)).toEqual(['install', '-g', '@xai-official/grok@latest']);
    expect(isAllowedUpdateArgv(r[1]!.argv)).toBe(true);
  });
});

describe('patchGrokToml', () => {
  const patch = {
    apiBackend: 'responses' as const,
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
  };
  it('creates the managed block and sets default', () => {
    const out = patchGrokToml(null, patch);
    expect(out).toContain(GROK_MARK_BEGIN);
    expect(out).toContain('[model.nomi]');
    expect(out).toContain(`env_key = "${GROK_KEY_ENV}"`);
    expect(out).toContain('api_backend = "responses"');
    expect(out).toContain('default = "nomi"');
  });
  it('replaces an existing block and keeps user content', () => {
    const first = patchGrokToml('# keep\n', patch);
    const second = patchGrokToml(first, { ...patch, model: 'grok-4.5' });
    expect(second.match(/nomi managed/g)).toHaveLength(2);
    expect(second).toContain('# keep');
    expect(second).toContain('grok-4.5');
    expect(second).not.toContain('model = "grok-4"');
  });
  it('removes only the marked block', () => {
    expect(patchGrokToml(patchGrokToml('# keep\n', patch), null)).toContain('# keep');
    expect(patchGrokToml(patchGrokToml(null, patch), null)).toBe('');
  });

  /** 无 TOML 解析器依赖：只检查「同表重复定义 / 同表重复键」这两类会让 TOML 非法的错误 */
  function assertValidTables(toml: string): Record<string, string[]> {
    const tables: Record<string, string[]> = {};
    let cur = '';
    for (const line of toml.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const h = /^\[([^\]]+)\]$/.exec(t);
      if (h) {
        cur = h[1]!;
        expect(tables[cur]).toBeUndefined();
        tables[cur] = [];
        continue;
      }
      const k = /^([A-Za-z0-9_.-]+)\s*=/.exec(t);
      if (k) {
        expect(tables[cur] ?? (tables[cur] = [])).not.toContain(k[1]);
        tables[cur]!.push(k[1]!);
      }
    }
    return tables;
  }

  it('existing [models] table: switches default in place, no duplicate table (#24)', () => {
    const raw =
      '# top\n[models]\n# my pick\ndefault = "user-model"\nextra = 1\n\n[ui]\ntheme = "dark"\n';
    const out = patchGrokToml(raw, patch);
    const tables = assertValidTables(out);
    expect(out.match(/^\[models\]$/gm)).toHaveLength(1);
    expect(tables['models']).toEqual(['default', 'extra']);
    expect(out).toContain('default = "nomi"');
    expect(out).toContain('# my pick');
    expect(out).toContain('extra = 1');
    expect(out).toContain('[ui]');
    expect(out).toContain('[model.nomi]');
  });

  it('existing [models] without default gets one inserted in that table (#24)', () => {
    const out = patchGrokToml('[models]\nextra = 1\n', patch);
    const tables = assertValidTables(out);
    expect(tables['models']).toEqual(['default', 'extra']);
  });

  it('re-activation keeps the first recorded original default; cancel restores it (#24)', () => {
    const raw = '[models]\ndefault = "user-model" # fav\nextra = 1\n';
    const first = patchGrokToml(raw, patch);
    const second = patchGrokToml(first, { ...patch, model: 'grok-4.5' });
    assertValidTables(second);
    expect(second.match(/^\[models\]$/gm)).toHaveLength(1);
    expect(second.match(/\[model\.nomi\]/g)).toHaveLength(1);
    expect(second).toContain('grok-4.5');
    const restored = patchGrokToml(second, null);
    expect(restored).toBe(raw);
  });

  it('cancel removes an inserted default when the user had none (#24)', () => {
    const raw = '[models]\nextra = 1\n';
    expect(patchGrokToml(patchGrokToml(raw, patch), null)).toBe(raw);
  });

  it('keeps first-time activation (no [models]) and cancel round trip (#24)', () => {
    const raw = '[ui]\ntheme = "dark"\n';
    const out = patchGrokToml(raw, patch);
    const tables = assertValidTables(out);
    expect(tables['models']).toEqual(['default']);
    expect(patchGrokToml(out, null)).toBe(raw);
  });

  describe('header variants and root-level models are recognised (#24)', () => {
    // 真正的 TOML 解析：生成的配置必须合法，且 default 指向 nomi
    const parsed = (out: string) => parseToml(out) as Record<string, Record<string, unknown>>;
    it.each([
      [
        'comment after header',
        '[models] # mine\ndefault = "user-model"\n\n[ui] # look\ntheme = "dark"\n',
      ],
      ['spaces inside brackets', '[ models ]\ndefault = "user-model"\n[ ui ]\ntheme = "dark"\n'],
      ['root dotted key', 'models.default = "user-model"\n\n[ui]\ntheme = "dark"\n'],
      ['root dotted key, spaced', 'models . default = "user-model"\n[ui]\ntheme = "dark"\n'],
    ])('%s: one models table, valid TOML, cancel restores the original', (_n, raw) => {
      expect(() => parseToml(raw)).not.toThrow();
      const out = patchGrokToml(raw, patch);
      const j = parsed(out);
      expect(j.models).toMatchObject({ default: 'nomi' });
      expect(j.model).toHaveProperty('nomi');
      expect(j.ui).toEqual({ theme: 'dark' });
      // 再次启用不重复追加
      const again = patchGrokToml(out, { ...patch, model: 'grok-4.5' });
      expect(parsed(again).models).toMatchObject({ default: 'nomi' });
      expect(patchGrokToml(again, null)).toBe(raw);
    });

    it('a table header with a trailing comment ends the [models] scan (no edit in the next table)', () => {
      const raw = '[models]\nextra = 1\n[ui] # look\ndefault = "keep-me"\n';
      const j = parsed(patchGrokToml(raw, patch));
      expect(j.models).toEqual({ default: 'nomi', extra: 1 });
      expect(j.ui).toEqual({ default: 'keep-me' });
    });

    it('a spaced [ model.nomi ] left from an old run is replaced, not duplicated', () => {
      const raw = '[ model . nomi ]\nmodel = "old"\n\n[ui]\ntheme = "dark"\n';
      const j = parsed(patchGrokToml(raw, patch));
      expect((j.model as Record<string, { model: string }>).nomi.model).toBe(patch.model);
    });

    it('inline models table is refused instead of producing invalid TOML', () => {
      expect(() => patchGrokToml('models = { default = "x" }\n', patch)).toThrow(
        GrokInlineModelsError,
      );
    });
  });
});
