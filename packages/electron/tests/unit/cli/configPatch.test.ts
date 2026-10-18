jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAllowedUpdateArgv, updateRecipes } from '../../../src/cli/CliUpdateService';
import {
  DSH_MARK_BEGIN,
  GROK_MARK_BEGIN,
  GROK_KEY_ENV,
  patchDshYaml,
  patchGrokToml,
  backupFile,
  patchClaudeSettings,
  patchCodexAuth,
  patchCodexToml,
} from '../../../src/cli/configPatch';
import {
  claudeFormatNeedsRouting,
  codexFormatNeedsRouting,
  defaultFormat,
  formatNeedsRouting,
  grokApiBackend,
} from '../../../src/cli/formats';

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

describe('api formats routing flags', () => {
  it('claude native does not need routing; others do', () => {
    expect(claudeFormatNeedsRouting('anthropic_messages')).toBe(false);
    expect(claudeFormatNeedsRouting('openai_chat_completions')).toBe(true);
    expect(claudeFormatNeedsRouting('openai_responses')).toBe(true);
    expect(claudeFormatNeedsRouting('gemini_generate_content')).toBe(true);
  });

  it('codex native does not need routing; others do', () => {
    expect(codexFormatNeedsRouting('openai_responses')).toBe(false);
    expect(codexFormatNeedsRouting('openai_chat_completions')).toBe(true);
    expect(codexFormatNeedsRouting('anthropic_messages')).toBe(true);
    expect(formatNeedsRouting('codex', 'openai_chat_completions')).toBe(true);
  });

  it('defaultFormat is each CLI native protocol', () => {
    expect(defaultFormat('claude')).toBe('anthropic_messages');
    expect(defaultFormat('codex')).toBe('openai_responses');
    expect(defaultFormat('dsh')).toBe('openai_responses');
    expect(defaultFormat('grok')).toBe('openai_responses');
    expect(formatNeedsRouting('claude', defaultFormat('claude'))).toBe(false);
    expect(formatNeedsRouting('codex', defaultFormat('codex'))).toBe(false);
    expect(formatNeedsRouting('dsh', defaultFormat('dsh'))).toBe(false);
    expect(formatNeedsRouting('grok', defaultFormat('grok'))).toBe(false);
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

describe('grok formats', () => {
  it('defaultFormat is openai_responses and never needs routing', () => {
    expect(defaultFormat('grok')).toBe('openai_responses');
    expect(formatNeedsRouting('grok', defaultFormat('grok'))).toBe(false);
    expect(grokApiBackend('openai_responses')).toBe('responses');
    expect(grokApiBackend('openai_chat_completions')).toBe('chat_completions');
    expect(grokApiBackend('anthropic_messages')).toBe('messages');
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
});
