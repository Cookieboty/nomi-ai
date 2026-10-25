/**
 * 客户端规格由宿主组装（P9.4 / P9.5）：内核只带 Nomi 自己的规格；客户端 id 是开放的，
 * 但只认登记了规格的（令牌、标签绑定都一样）。内置编程助手的规格由 tests/setup/clients.ts 从插件登记。
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_GATEWAY_ENTRIES } from '../../cli-plugins/src/gateways';
import {
  BUILTIN_CLIENT_SPECS,
  ClientConformer,
  clientSpecOf,
  legacyClientOf,
  registerClientSpec,
  registeredClientIds,
} from '../src/clients/index';
import type { GatewayConfig } from '../src/config';
import { createGateway } from '../src/server';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const TOKEN = `nomi-tab-${'b'.repeat(43)}`;

const cfg = (clients: GatewayConfig['clients']): GatewayConfig => ({
  host: '127.0.0.1',
  port: 0,
  providers: [],
  clients,
});

async function start(c: GatewayConfig) {
  const gw = createGateway(c, { bindingWaitMs: 50 });
  await gw.start();
  cleanups.push(() => gw.stop());
  const call = (token: string) =>
    fetch(`${gw.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
  return { gw, call };
}

describe('client specs come from the host (P9.5)', () => {
  it('the kernel itself only ships the Nomi spec', () => {
    expect(BUILTIN_CLIENT_SPECS.map((s) => s.id)).toEqual(['nomi']);
  });

  it('every built-in plugin entry is registered, in the legacy identification order', () => {
    expect(BUILTIN_GATEWAY_ENTRIES.map((e) => e.client)).toEqual([
      'claude',
      'codex',
      'grok',
      'dsh',
      'gemini',
    ]);
    for (const e of BUILTIN_GATEWAY_ENTRIES) {
      expect(e.clientSpec.id).toBe(e.client);
      expect(clientSpecOf(e.client)).toBe(e.clientSpec);
    }
    expect(registeredClientIds()).toEqual(['nomi', 'claude', 'codex', 'grok', 'dsh', 'gemini']);
  });

  it('legacy identification is unchanged (ingress first, then User-Agent)', () => {
    expect(legacyClientOf('messages', 'codex_cli_rs/0.1')).toBe('claude');
    expect(legacyClientOf('responses', 'codex_cli_rs/0.1')).toBe('codex');
    expect(legacyClientOf('responses', 'grok-build/1.0')).toBe('grok');
    expect(legacyClientOf('chat', 'dsh/2')).toBe('dsh');
    expect(legacyClientOf('gemini', 'node')).toBe('gemini');
    expect(legacyClientOf('chat', 'curl/8')).toBeNull();
  });

  it("acceptedEvents: 'spec' drops events outside the Responses spec for Grok", () => {
    const notes: string[] = [];
    const c = new ClientConformer({ spec: clientSpecOf('grok')!, wire: 'responses', notes });
    const out = c.push(
      'data: {"type":"response.created","response":{}}\n\n' +
        'data: {"type":"x.vendor.keepalive"}\n\n',
    );
    expect(out).toContain('response.created');
    expect(out).not.toContain('x.vendor.keepalive');
    expect(notes).toEqual(['已丢掉 grok 不接受的事件 x.vendor.keepalive']);
  });
});

describe('open client ids (P9.4)', () => {
  it('a client token whose id has no registered spec is rejected', async () => {
    const g = await start(cfg({ 'not-registered': { token: 'tok-unknown-client' } }));
    expect((await g.call('tok-unknown-client')).status).toBe(401);
  });

  it('a tab binding for an unregistered client is rejected', async () => {
    const g = await start(cfg({}));
    g.gw.bindings.add({
      tokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      client: 'not-registered',
      tabId: 't',
      generation: 1,
      models: { main: 'p/m' },
    });
    expect((await g.call(TOKEN)).status).toBe(401);
  });

  it('a newly registered client id is accepted', async () => {
    registerClientSpec({ id: 'acme-cli', strictness: 'lenient', unknownToMain: true });
    const g = await start(cfg({ 'acme-cli': { token: 'tok-acme-client' } }));
    // 认出了身份（没有可用模型 → 不是 401）
    expect((await g.call('tok-acme-client')).status).not.toBe(401);
  });
});
