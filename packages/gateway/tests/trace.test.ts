/**
 * 调试追踪（§14）：脱敏、24 小时清理、经网关写出的追踪文件。
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig } from '../src/config';
import { createGateway, type UsageEvent } from '../src/server';
import {
  pruneTraces,
  redactHeaders,
  redactJson,
  redactText,
  RequestTrace,
  secretsOf,
  TRACE_MAX_AGE_MS,
} from '../src/trace';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-trace-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const cfgBase = (extra: Partial<GatewayConfig> = {}): GatewayConfig => ({
  host: '127.0.0.1',
  port: 0,
  providers: [
    {
      id: 'zp',
      name: 'ZP',
      enabled: true,
      urls: {},
      keys: [{ id: 'k1', name: '主 Key', value: 'zp-secret-value-123456', enabled: true }],
      models: [{ id: 'glm-5', enabled: true }],
    },
  ],
  clients: { claude: { token: 'tok-claude-abcdef', models: { main: 'zp/glm-5' } } },
  ...extra,
});

describe('redaction', () => {
  it('replaces known secrets and common key formats in text', () => {
    const out = redactText(
      'key zp-secret-value-123456 and Bearer abc.def-ghi and sk-ant-1234567890abcd and AIzaSyA1234567890abcdefghijk and https://x/y?key=foo123&a=1',
      ['zp-secret-value-123456'],
    );
    expect(out).not.toContain('zp-secret-value-123456');
    expect(out).not.toContain('abc.def-ghi');
    expect(out).not.toContain('sk-ant-1234567890abcd');
    expect(out).not.toContain('AIzaSyA1234567890abcdefghijk');
    expect(out).not.toContain('foo123');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('?key=[REDACTED]&a=1');
  });

  it('redacts secret fields by name but keeps token counts', () => {
    const out = redactJson(
      {
        api_key: 'plain',
        nested: { access_token: 'x', password: 'p' },
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'my key is zp-secret-value-123456' }],
      },
      ['zp-secret-value-123456'],
    ) as Record<string, unknown>;
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.nested).toEqual({ access_token: '[REDACTED]', password: '[REDACTED]' });
    expect(out.max_tokens).toBe(1024);
    expect(JSON.stringify(out.messages)).not.toContain('zp-secret-value-123456');
  });

  it('redacts auth headers', () => {
    const h = redactHeaders({
      authorization: 'Bearer tok-claude-abcdef',
      'x-api-key': 'whatever',
      'x-goog-api-key': 'g',
      'content-type': 'application/json',
      'user-agent': 'claude-cli',
    });
    expect(h.authorization).toBe('[REDACTED]');
    expect(h['x-api-key']).toBe('[REDACTED]');
    expect(h['x-goog-api-key']).toBe('[REDACTED]');
    expect(h['content-type']).toBe('application/json');
  });

  it('collects every key and token from the config', () => {
    const s = secretsOf(cfgBase({ legacyToken: 'legacy-token-xyz' }));
    expect(s).toEqual(
      expect.arrayContaining(['zp-secret-value-123456', 'tok-claude-abcdef', 'legacy-token-xyz']),
    );
  });
});

describe('pruneTraces', () => {
  it('deletes json files older than 24 h only', () => {
    const dir = tmpDir();
    const now = Date.now();
    const old = path.join(dir, 'old.json');
    const fresh = path.join(dir, 'fresh.json');
    const other = path.join(dir, 'keep.txt');
    for (const f of [old, fresh, other]) fs.writeFileSync(f, '{}');
    const past = (now - TRACE_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(old, past, past);
    fs.utimesSync(other, past, past);
    expect(pruneTraces(dir, now)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('returns 0 for a missing directory', () => {
    expect(pruneTraces(path.join(os.tmpdir(), 'no-such-trace-dir-xyz'))).toBe(0);
  });
});

describe('RequestTrace', () => {
  it('writes a 0600 file named <timestamp>-<client>.json with secrets removed', async () => {
    const dir = path.join(tmpDir(), 'trace');
    const t = new RequestTrace(
      dir,
      cfgBase(),
      {
        client: 'claude',
        ingress: 'messages',
        path: '/v1/messages',
        startedAt: Date.UTC(2026, 9, 21, 8, 0, 0, 5),
      },
      { id: 'abc123' },
    );
    t.request({ 'x-api-key': 'tok-claude-abcdef' }, { model: 'zp/glm-5', max_tokens: 10 });
    t.attempt({
      provider: 'ZP',
      key: '主 Key',
      wire: 'chat',
      url: 'https://up/v1/chat/completions',
      headers: { authorization: 'Bearer zp-secret-value-123456' },
      body: { model: 'glm-5' },
    });
    t.response(200, 'data: {"echo":"zp-secret-value-123456"}\n\n');
    const file = await t.finish({ status: 200, ms: 12, attempts: 1 });
    expect(file).toBeTruthy();
    expect(path.basename(file!)).toBe('2026-10-21T08-00-00-005Z-claude-abc123.json');
    // finish() 在原子发布完成后才返回：立刻读就应是完整 JSON，目录里也不该留 .tmp
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const raw = fs.readFileSync(file!, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).not.toContain('zp-secret-value-123456');
    expect(raw).not.toContain('tok-claude-abcdef');
    if (process.platform !== 'win32') expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(raw);
    expect(doc.request.body.max_tokens).toBe(10);
    expect(doc.upstream[0].provider).toBe('ZP');
    // 同一毫秒的第二个请求不覆盖
    const t2 = new RequestTrace(
      dir,
      cfgBase(),
      {
        client: 'claude',
        ingress: 'messages',
        path: '/v1/messages',
        startedAt: Date.UTC(2026, 9, 21, 8, 0, 0, 5),
      },
      { id: 'abc123' },
    );
    const f2 = await t2.finish({ status: 200, ms: 1, attempts: 1 });
    expect(path.basename(f2!)).toBe('2026-10-21T08-00-00-005Z-claude-abc123-2.json');
  });
});

describe('gateway with traceDir', () => {
  async function upstream() {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'c1',
            model: 'glm-5',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    return { base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
  }

  it('writes one redacted trace per request and reports firstByteMs', async () => {
    const up = await upstream();
    const dir = path.join(tmpDir(), 'trace');
    const usage: UsageEvent[] = [];
    const base = cfgBase();
    base.providers[0]!.urls = { chat: `${up.base}/v1` };
    const gw = createGateway(
      { ...base, allowedPrivateHosts: [up.hostPort], traceDir: dir },
      { onUsage: (e) => usage.push(e) },
    );
    await gw.start();
    cleanups.push(() => gw.stop());
    const r = await fetch(`${gw.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-claude-abcdef' },
      body: JSON.stringify({ model: 'zp/glm-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    // 写盘是异步的；等可解析的 .json（忽略 .tmp），避免读到尚未写完的文件
    let raw = '';
    let files: string[] = [];
    for (let i = 0; i < 100; i++) {
      files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
      if (files.length === 1) {
        try {
          raw = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
          JSON.parse(raw);
          break;
        } catch {
          raw = '';
        }
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-claude-[0-9a-f]{12}\.json$/);
    expect(raw).not.toContain('tok-claude-abcdef');
    expect(raw).not.toContain('zp-secret-value-123456');
    const doc = JSON.parse(raw);
    expect(doc.response.body).toContain('"hi"');
    const upHeaders = doc.upstream[0].headers as Record<string, string>;
    const auth = Object.entries(upHeaders).find(([k]) => k.toLowerCase() === 'authorization');
    expect(auth?.[1]).toBe('[REDACTED]');
    expect(usage[0]?.firstByteMs).toBeGreaterThanOrEqual(0);
  });

  it('writes nothing without traceDir', async () => {
    const up = await upstream();
    const base = cfgBase();
    base.providers[0]!.urls = { chat: `${up.base}/v1` };
    const gw = createGateway({ ...base, allowedPrivateHosts: [up.hostPort] }, {});
    await gw.start();
    cleanups.push(() => gw.stop());
    const r = await fetch(`${gw.listenUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-claude-abcdef' },
      body: JSON.stringify({ model: 'zp/glm-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    expect(gw.config.traceDir).toBeUndefined();
  });
});
