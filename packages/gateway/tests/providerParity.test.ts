/**
 * 供应商规格（§6.3、P5.4）：把 fixes.ts 的供应商部分与预设 quirks 迁进 providers/ 之后，
 * 发给上游的请求体与请求头必须与迁移前逐字节一致。快照在迁移之前生成。
 */
import { describe, expect, it } from 'vitest';

import type { ProviderQuirks, RuntimeProvider } from '../src/config';
import type { Wire } from '../src/ir';
import type { Candidate } from '../src/route/resolve';
import { upstreamBody, upstreamHeaders } from '../src/upstream';

const WIRES: Wire[] = ['messages', 'responses', 'chat', 'gemini'];

const HOSTS: Record<string, { base: string; quirks?: ProviderQuirks }> = {
  anthropic: { base: 'https://api.anthropic.com' },
  openai: { base: 'https://api.openai.com/v1' },
  relay: { base: 'https://relay.example.com/v1' },
  deepseek: { base: 'https://api.deepseek.com', quirks: { reasoningPassback: true } },
  kimi: {
    base: 'https://api.moonshot.cn/v1',
    quirks: {
      dropParams: ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty'],
      reasoningPassback: true,
      maxTools: 128,
    },
  },
  minimax: {
    base: 'https://api.minimaxi.com/v1',
    quirks: {
      dropParams: ['service_tier'],
      reasoningPassback: true,
      extraBody: { chat: { reasoning_split: true } },
      userAgent: 'nomi-test/1.0',
    },
  },
};

function cand(name: string, wire: Wire): Candidate {
  const h = HOSTS[name]!;
  const provider: RuntimeProvider = {
    id: name,
    name,
    enabled: true,
    urls: { [wire]: h.base },
    keys: [{ id: 'k', value: 'sk-test-0000000000', enabled: true }],
    models: [{ id: 'm', enabled: true, maxOutput: 8000, vision: false }],
    ...(h.quirks ? { quirks: h.quirks } : {}),
  };
  return {
    provider,
    key: provider.keys[0]!,
    publicModel: `${name}/m`,
    upstreamModel: 'm',
    wire,
    ...(h.quirks?.dropParams ? { dropParams: h.quirks.dropParams } : {}),
  };
}

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { p: { type: 'string', examples: ['a'] } },
};

const BODIES: Record<Wire, unknown> = {
  messages: {
    model: 'x',
    max_tokens: 20000,
    system: 'sys',
    thinking: { type: 'enabled', budget_tokens: 30000 },
    output_config: { effort: 'high' },
    context_management: { edits: [] },
    temperature: 0.5,
    tools: [
      { name: 'read', input_schema: schema },
      { type: 'web_search_20250305', name: 'web_search' },
    ],
    messages: [
      { role: 'system', content: 'inline system' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  },
  responses: {
    model: 'x',
    max_output_tokens: 20000,
    reasoning: { effort: 'high' },
    tools: [{ type: 'function', name: 'read', parameters: schema }],
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  },
  chat: {
    model: 'x',
    max_tokens: 20000,
    temperature: 0.5,
    service_tier: 'auto',
    tools: [{ type: 'function', function: { name: 'mcp.read/file', parameters: schema } }],
    messages: [{ role: 'user', content: 'hi' }],
  },
  gemini: {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 20000 },
    tools: [{ functionDeclarations: [{ name: 'read', parameters: schema }] }],
  },
};

describe('request parity across the provider-spec migration', () => {
  for (const name of Object.keys(HOSTS))
    for (const ingress of WIRES)
      for (const wire of WIRES)
        it(`${name}: ${ingress} → ${wire}`, () => {
          const c = cand(name, wire);
          const notes: string[] = [];
          const body = upstreamBody(ingress, c, BODIES[ingress], {
            stream: true,
            notes,
            client: 'claude',
          });
          const headers = upstreamHeaders(c, {
            stream: true,
            sameWire: ingress === wire,
            clientHeaders: {
              'user-agent': 'claude-cli/9',
              'anthropic-beta': 'context-1m-2025,fine-grained-tool-streaming-2025',
            },
          });
          expect(JSON.stringify({ body, headers, notes }, null, 1)).toMatchSnapshot();
        });
});
