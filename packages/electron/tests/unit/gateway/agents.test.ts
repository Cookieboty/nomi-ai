jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { agentLaunch, stripGatewayLeftovers, STRIP } from '../../../src/gateway/agents';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const base = (o: Partial<Parameters<typeof agentLaunch>[1]> = {}) => ({
  url: 'http://127.0.0.1:18721',
  token: 'nomi-gw-x-token',
  model: 'zp/glm-5',
  models: {},
  dir: tmp('agent-dir-'),
  ...o,
});
const meta = {
  'zp/glm-5': {
    label: 'GLM-5',
    provider: '智谱',
    ctx: 200_000,
    maxOutput: 131_072,
    reasoning: true,
  },
  'ds/chat': {
    label: 'DS Chat',
    provider: 'DeepSeek',
    ctx: 64_000,
    maxOutput: 8_000,
    reasoning: false,
    vision: false,
  },
} as Record<string, object>;

describe('agent launches (§12, §12.7.1)', () => {
  it('Claude: gateway URL + AUTH_TOKEN, tiers default to the tab model, real model params', () => {
    const l = agentLaunch(
      'claude',
      base({ models: { tiers: { haiku: 'ds/chat' } }, metaOf: (r) => meta[r] }),
    );
    expect(l.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18721',
      ANTHROPIC_AUTH_TOKEN: 'nomi-gw-x-token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'zp/glm-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ds/chat',
      ANTHROPIC_SMALL_FAST_MODEL: 'zp/glm-5',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '131072',
      MAX_THINKING_TOKENS: '16000',
      ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: 'thinking,interleaved_thinking',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: 'temperature',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'GLM-5',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(l.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(l.strip).toContain('ANTHROPIC_API_KEY');
    // 没有元数据：保守默认值，非推理
    const plain = agentLaunch('claude', base());
    expect(plain.env).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      MAX_THINKING_TOKENS: '0',
    });
  });

  it('Codex: -c provider pointing at the gateway, real context window, catalog from the user cache as template', () => {
    const home = tmp('codex-home-');
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(
      path.join(home, '.codex', 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-5.5',
            base_instructions: 'You are Codex',
            context_window: 272_000,
            input_modalities: ['text', 'image'],
            supported_reasoning_levels: [{ effort: 'low' }],
            default_reasoning_level: 'medium',
          },
        ],
      }),
    );
    const l = agentLaunch(
      'codex',
      base({ model: 'ds/chat', home, metaOf: (r) => meta[r], catalog: ['zp/glm-5', 'ds/chat'] }),
    );
    expect(l.env).toEqual({ NOMI_GATEWAY_KEY: 'nomi-gw-x-token' });
    const args = l.args.join(' ');
    expect(args).toContain('model_provider="nomi_gateway"');
    expect(args).toContain('base_url="http://127.0.0.1:18721/v1"');
    expect(args).toContain('env_key="NOMI_GATEWAY_KEY"');
    expect(args).toContain('model_context_window=64000');
    expect(args).toContain('model_auto_compact_token_limit=51200');
    const file = /model_catalog_json="([^"]+)"/.exec(args)![1]!;
    const cat = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      models: Array<Record<string, unknown>>;
    };
    expect(cat.models.map((m) => m.slug)).toEqual(['ds/chat', 'zp/glm-5']);
    expect(cat.models[0]).toMatchObject({
      base_instructions: 'You are Codex',
      context_window: 64_000,
      input_modalities: ['text'],
      supported_reasoning_levels: [],
    });
    expect(cat.models[1]).toMatchObject({
      context_window: 200_000,
      input_modalities: ['text', 'image'],
    });
    // 没有缓存：不生成目录
    const none = agentLaunch('codex', base({ home: tmp('codex-empty-') }));
    expect(none.args.join(' ')).not.toContain('model_catalog_json');
    expect(l.strip).toEqual(STRIP.codex);
  });

  it('Gemini: env only, model by GEMINI_MODEL', () => {
    const l = agentLaunch('gemini', base());
    expect(l.env).toEqual({
      GEMINI_CLI_AUTH_OVERRIDE: 'gemini-api-key',
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:18721',
      GEMINI_API_KEY: 'nomi-gw-x-token',
      GEMINI_MODEL: 'zp/glm-5',
    });
    expect(l.modelInConfig).toBe(true);
  });

  it('dsh: private --patch overlay with the gateway and the model; token by env', () => {
    const l = agentLaunch('dsh', base());
    expect(l.args[0]).toBe('--patch');
    const yaml = fs.readFileSync(l.args[1]!, 'utf8');
    expect(yaml).toContain('http://127.0.0.1:18721/v1');
    expect(yaml).toContain('zp/glm-5');
    expect(yaml).not.toContain('nomi-gw-x-token');
    expect(l.env).toEqual({ NOMI_DSH_API_KEY: 'nomi-gw-x-token' });
  });

  it('Grok: private GROK_HOME with a generated config; shared entries symlinked back; ~/.grok untouched', () => {
    const home = tmp('grok-home-');
    const shared = path.join(home, '.grok');
    fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'config.toml'), '# mine\n');
    fs.writeFileSync(path.join(shared, 'auth.json'), '{"token":"official"}');
    fs.writeFileSync(path.join(shared, 'auth.json.lock'), '');
    fs.mkdirSync(path.join(shared, 'installed-plugins'));
    const dir = path.join(tmp('grok-agent-'), 'tab-1');
    const l = agentLaunch('grok', base({ home, dir }));
    expect(l.env).toEqual({ GROK_HOME: dir, NOMI_GROK_API_KEY: 'nomi-gw-x-token' });
    const conf = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    expect(conf).toContain('model = "zp/glm-5"');
    expect(conf).toContain('base_url = "http://127.0.0.1:18721/v1"');
    expect(conf).toContain('env_key = "NOMI_GROK_API_KEY"');
    expect(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(dir, 'installed-plugins')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'auth.json.lock'))).toBe(false);
    expect(fs.readFileSync(path.join(shared, 'config.toml'), 'utf8')).toBe('# mine\n');
    // 再次启动（换模型）：重写配置，不重复建链
    agentLaunch('grok', base({ home, dir, model: 'zp/glm-5-air' }));
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toContain('zp/glm-5-air');
  });

  it('official sessions drop leftovers pointing at the gateway, keep the user own values', () => {
    const out = stripGatewayLeftovers(
      {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:18721',
        OPENAI_BASE_URL: 'http://127.0.0.1:18721/v1',
        ANTHROPIC_AUTH_TOKEN: 'nomi-gw-claude-abc',
        SOMETHING: 'Bearer secret-token-x',
        OPENAI_API_KEY: 'sk-user',
        PATH: '/usr/bin',
      },
      { url: 'http://127.0.0.1:18721', tokens: ['secret-token-x'] },
    );
    expect(out).toEqual({ OPENAI_API_KEY: 'sk-user', PATH: '/usr/bin' });
  });
});
