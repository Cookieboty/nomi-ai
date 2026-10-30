#!/usr/bin/env node
/**
 * Batch 5 ProviderService ping parity recorder (D-B4d-3): drives the real ProviderService.ts
 * (test / testDraft / fetchModels / fetchModelsDraft) over a real ProviderStore with a scripted
 * fetchImpl and provider factory (scripts/parity/b5-ping-scenarios.json). Records fetch requests
 * (url + lower-cased sorted headers), factory options, chat requests, results / thrown errors and
 * the final provider views. Date.now is pinned. Replayed by internal/ai/providers/ping_parity_test.go.
 *
 * Usage: node scripts/parity/record-b5-ping.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { register } from 'tsx/esm/api';

register();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rt = (p) =>
  import(pathToFileURL(join(root, 'apps/desktop-electron/internal/ai-runtime/src', p)).href);
const { ProviderService } = await rt('providers/ProviderService.ts');
const { ProviderStore } = await rt('providers/ProviderStore.ts');
const { plaintextCipher } = await rt('providers/secretCipher.ts');
const spec = JSON.parse(readFileSync(join(root, 'scripts/parity/b5-ping-scenarios.json'), 'utf8'));

const NOW = 1_700_000_000_000;
Date.now = () => NOW;

const ev = [];
const log = (k, v) => ev.push(k + ':' + (v === undefined ? 'undefined' : JSON.stringify(v)));
const hdrs = (h) =>
  Object.fromEntries(
    Object.entries(h)
      .map(([k, v]) => [k.toLowerCase(), v])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

const fetchImpl = async (url, init) => {
  log('fetch', { url, headers: hdrs(init.headers) });
  const b = spec.fetch[url];
  if (!b || b.network) throw new TypeError('fetch failed');
  if (b.hang)
    return new Promise((_, rej) =>
      init.signal.addEventListener('abort', () =>
        rej(new DOMException('This operation was aborted', 'AbortError')),
      ),
    );
  return new Response(b.body, { status: b.status });
};

const pick = (o) => {
  const out = {};
  for (const k of [
    'id',
    'protocol',
    'baseURL',
    'fullUrl',
    'defaultModel',
    'modelMap',
    'headers',
    'userAgent',
    'thinking',
    'apiKey',
    'requiresApiKey',
  ])
    if (o[k] !== undefined) out[k] = o[k];
  return out;
};
const fake = (key) => {
  const b = spec.chat[key ?? ''];
  if (b?.ctor) throw new Error(b.ctor);
  return {
    id: 'x',
    async chat(req) {
      log('chatReq', req);
      await null;
      if (!b) throw new Error('no behavior');
      if (b.hang) return new Promise(() => {});
      if (b.throw) throw new Error(b.throw);
      return { reqId: req.reqId, provider: req.provider, finishReason: 'stop', ...b.res };
    },
    async *stream() {},
    abort() {},
  };
};

const dir = mkdtempSync(join(tmpdir(), 'b5p-'));
const file = join(dir, 'p.json');
writeFileSync(
  file,
  JSON.stringify({
    version: 2,
    providers: spec.providers.map((p) => ({
      id: p.id,
      presetId: p.presetId,
      name: p.id,
      protocol: p.protocol,
      baseURL: p.baseURL,
      fullUrl: false,
      defaultModel: p.defaultModel ?? '',
      models: [],
      ...(p.headers ? { headers: p.headers } : {}),
      ...(p.userAgent ? { userAgent: p.userAgent } : {}),
      enabled: true,
      keys: p.keys.map((k, i) => ({
        id: `k${i}`,
        secret: Buffer.from(k).toString('base64'),
        encryption: 'none',
        masked: '****',
        createdAt: 1,
      })),
      createdAt: 1,
      updatedAt: 1,
    })),
    routes: {},
    usage: {},
  }),
);
const store = new ProviderStore({
  filePath: file,
  cipher: plaintextCipher,
  now: () => NOW,
  usageFlushMs: 3_600_000,
});
const envFakes = { openai: fake('env:openai') };
const svc = new ProviderService({
  store,
  envEntries: [],
  getRegistry: () => ({ get: (id) => envFakes[id] }),
  factory: (o) => {
    log('factory', pick(o));
    return fake(o.apiKey);
  },
  testTimeoutMs: 50,
  fetchImpl,
});
for (const op of spec.ops) {
  try {
    const arg = op.input ?? op.id;
    log(op.op, await (op.op === 'test' ? svc.test(op.id, op.keyId) : svc[op.op](arg)));
  } catch (e) {
    log('opErr', String(e?.message ?? e));
  }
}
log('views', store.list());
const out = join(root, 'apps/desktop-go/internal/ai/providers/testdata/parity/b5_ping.json.gz');
writeFileSync(out, gzipSync(JSON.stringify({ events: ev }, null, 1)));
console.log(`recorded ${spec.ops.length} ops, ${ev.length} events → ${out}`);
process.exit(0);
