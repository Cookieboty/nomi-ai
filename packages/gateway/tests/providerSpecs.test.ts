/**
 * 供应商规格（§6.3，P5）：匹配顺序、quirks 合并、与预设的 quirks 不漂移、
 * 响应方向的保活识别（转成心跳）与私有事件丢弃（Amux 回放）。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { PROVIDER_PRESETS } from '../../ai-runtime/src/providers/presets';
import type { GatewayConfig, RuntimeProvider } from '../src/config';
import {
  amux,
  BUILTIN_SPECS,
  declarativePreEvent,
  mergeQuirks,
  ProviderStage,
  quirksOf,
  specOf,
} from '../src/providers/index';
import { createGateway } from '../src/server';
import { HEARTBEAT_COMMENT, HEARTBEAT_PING } from '../src/stream/heartbeat';

const prov = (o: Partial<RuntimeProvider>): RuntimeProvider => ({
  id: 'p',
  name: 'P',
  enabled: true,
  urls: {},
  keys: [],
  models: [],
  ...o,
});

describe('spec matching', () => {
  it('explicit spec → preset → host (incl. subdomain) → generic', () => {
    expect(specOf(prov({ spec: 'amux', urls: { chat: 'https://api.deepseek.com' } })).id).toBe(
      'amux',
    );
    expect(specOf(prov({ preset: 'kimi', urls: { chat: 'https://relay.example' } })).id).toBe(
      'kimi',
    );
    expect(specOf(prov({ urls: { chat: 'https://eu.gateway.amux.ai/v1' } })).id).toBe('amux');
    expect(specOf(prov({ urls: { chat: 'https://relay.example/v1' } })).id).toBe('generic');
  });

  it('per wire: a provider whose Messages address is Anthropic official', () => {
    const p = prov({
      urls: { chat: 'https://relay.example/v1', messages: 'https://api.anthropic.com' },
    });
    expect(specOf(p, 'messages').id).toBe('anthropic');
    expect(specOf(p, 'chat').id).toBe('generic');
  });

  it('quirks: config overrides the spec; dropParams are unioned; nested objects merge', () => {
    const q = mergeQuirks(
      {
        dropParams: ['a'],
        maxTools: 10,
        fixes: { repetition: true },
        extraBody: { chat: { x: 1 } },
      },
      {
        dropParams: ['b'],
        maxTools: 20,
        fixes: { toolNames: false },
        extraBody: { chat: { y: 2 } },
      },
    );
    expect(q).toEqual({
      dropParams: ['a', 'b'],
      maxTools: 20,
      fixes: { repetition: true, toolNames: false },
      extraBody: { chat: { x: 1, y: 2 } },
    });
    // 自建的 DeepSeek（没用预设）按域名也拿到推理回传
    expect(quirksOf(prov({ urls: { chat: 'https://api.deepseek.com' } })).reasoningPassback).toBe(
      true,
    );
  });

  it('built-in request quirks match the ai-runtime presets (no drift)', () => {
    for (const spec of BUILTIN_SPECS)
      for (const id of spec.match.presets ?? []) {
        const preset = PROVIDER_PRESETS.find((p) => p.id === id);
        if (!preset?.quirks) continue;
        expect({ id, quirks: spec.request }).toEqual({ id, quirks: preset.quirks });
      }
  });
});

describe('response pre-events', () => {
  const ka = JSON.stringify({ type: 'response.output_text.delta', item_id: 'SSE-Keep-Alive' });
  it('declarative rules: keepalive → alive, private event → drop, others untouched', () => {
    expect(declarativePreEvent(amux, { data: ka })).toBe('alive');
    expect(declarativePreEvent(amux, { data: '{"type":"response.metadata"}' })).toBeNull();
    const ok = { data: '{"type":"response.output_text.delta","delta":"x"}' };
    expect(declarativePreEvent(amux, ok)).toBe(ok);
  });

  it('ProviderStage keeps unmatched bytes identical and counts keepalives', () => {
    const s = new ProviderStage(amux, 'responses');
    const real =
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta"}\r\n\r\n';
    const out = s.push(`data: ${ka}\n\n` + real.slice(0, 20)) + s.push(real.slice(20)) + s.end();
    expect(out).toBe(real);
    expect(s.alive).toBe(1);
  });
});

/* ------------------------------- Amux 回放 ------------------------------- */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const ev = (o: Record<string, unknown>) =>
  `event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`;
const KEEPALIVE = ev({
  type: 'response.output_text.delta',
  item_id: 'SSE-Keep-Alive',
  output_index: 0,
  content_index: 0,
  delta: '',
  'SSE-Keep-Alive': true,
});
const CREATED = ev({ type: 'response.created', sequence_number: 0, response: { id: 'r1' } });
const METADATA = ev({ type: 'response.metadata', sequence_number: 1, metadata: { cost: 1 } });
const TEXT = ev({
  type: 'response.output_text.delta',
  sequence_number: 2,
  item_id: 'msg_1',
  output_index: 0,
  content_index: 0,
  delta: 'hello',
});
const DONE = ev({
  type: 'response.completed',
  sequence_number: 3,
  response: {
    id: 'r1',
    status: 'completed',
    output: [],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});
const FAILED = ev({
  type: 'response.failed',
  response: { error: { code: 'server_error', message: 'boom' } },
});

async function amuxGateway(script: (key: string) => string) {
  const keys: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = String(req.headers.authorization ?? '');
      keys.push(key);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(script(key));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const cfg: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    providers: [
      {
        id: 'amux',
        name: 'Amux',
        preset: 'amux',
        enabled: true,
        urls: { responses: `http://127.0.0.1:${port}/v1` },
        keys: [
          { id: 'k1', value: 'key-1', enabled: true },
          { id: 'k2', value: 'key-2', enabled: true },
        ],
        models: [{ id: 'gpt', enabled: true }],
      },
    ],
    clients: {
      codex: { token: 'tok-codex', models: { main: 'amux/gpt' } },
      claude: { token: 'tok-claude', models: { main: 'amux/gpt' } },
    },
    allowedPrivateHosts: [`127.0.0.1:${port}`],
  };
  const gw = createGateway(cfg, { streamIdleTimeoutMs: 2_000 });
  await gw.start();
  cleanups.push(() => gw.stop());
  return { gw, keys };
}

describe('Amux replay (P5.4)', () => {
  it('Responses passthrough: keepalives become comments, response.metadata is gone', async () => {
    const { gw } = await amuxGateway(
      () => CREATED + KEEPALIVE + METADATA + TEXT + KEEPALIVE + DONE,
    );
    const r = await fetch(`${gw.listenUrl()}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-codex' },
      body: JSON.stringify({ model: 'amux/gpt', stream: true, input: 'hi' }),
    });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain('SSE-Keep-Alive');
    expect(text).not.toContain('response.metadata');
    expect(text).toContain(HEARTBEAT_COMMENT);
    expect(text).toContain('"delta":"hello"');
    expect(text).toContain('response.completed');
  });

  it('Messages client (Claude Code): keepalives become ping events after message_start', async () => {
    const { gw } = await amuxGateway(() => CREATED + TEXT + KEEPALIVE + DONE);
    const r = await fetch(`${gw.listenUrl()}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-claude' },
      body: JSON.stringify({
        model: 'amux/gpt',
        stream: true,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const text = await r.text();
    expect(text).not.toContain('SSE-Keep-Alive');
    expect(text.indexOf('message_start')).toBeLessThan(text.indexOf(HEARTBEAT_PING));
    expect(text).toContain('hello');
  });

  it('a keepalive is not the first content event: an error after it still falls back', async () => {
    const { gw, keys } = await amuxGateway((key) =>
      key.endsWith('key-1') ? CREATED + KEEPALIVE + FAILED : CREATED + TEXT + DONE,
    );
    const r = await fetch(`${gw.listenUrl()}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-codex' },
      body: JSON.stringify({ model: 'amux/gpt', stream: true, input: 'hi' }),
    });
    const text = await r.text();
    expect(keys).toEqual(['Bearer key-1', 'Bearer key-2']);
    expect(text).toContain('"delta":"hello"');
    expect(text).not.toContain('boom');
  });
});
