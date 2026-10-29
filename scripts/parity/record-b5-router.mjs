#!/usr/bin/env node
/**
 * Batch 5 router parity recorder (D-B5-9): drives the real ProviderRouter.ts (TrackedProvider +
 * RoutedLLMRegistry) over a real ProviderStore (plaintext cipher, fixture file) with scripted fake
 * LLMProviders per scripts/parity/b5-router-scenarios.json. Records, per scenario, the ordered
 * event log: factory options, resolve/list results, chat responses / errors, stream chunks,
 * logCall + recordCall objects, and the final store usage + views. Date.now is pinned.
 * The Go replay (internal/ai/providers/router_parity_test.go) must match byte for byte.
 *
 * Usage: node scripts/parity/record-b5-router.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { register } from 'tsx/esm/api';
import { APICallError } from '@ai-sdk/provider';

register();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rt = (p) => import(pathToFileURL(join(root, 'packages/ai-runtime/src', p)).href);
const { RoutedLLMRegistry } = await rt('providers/ProviderRouter.ts');
const { ProviderStore } = await rt('providers/ProviderStore.ts');
const { plaintextCipher } = await rt('providers/secretCipher.ts');
const spec = JSON.parse(readFileSync(join(root, 'scripts/parity/b5-router-scenarios.json'), 'utf8'));

const NOW = 1_700_000_000_000;
Date.now = () => NOW;

const mkErr = (t) =>
  t.plain
    ? new Error(t.message)
    : new APICallError({ message: t.message, url: 'http://mock', requestBodyValues: {}, statusCode: t.statusCode });

function fake(id, key) {
  const b = spec.behaviors[key ?? id] ?? spec.behaviors[id] ?? spec.behaviors['k-nousage'];
  return {
    id,
    async chat(req) {
      await null;
      if (b.chat.throw) throw mkErr(b.chat.throw);
      return { reqId: req.reqId, provider: id, ...structuredClone(b.chat.res) };
    },
    async *stream() {
      for (const c of b.stream) {
        await null;
        yield structuredClone(c);
      }
      if (b.streamThrow) throw new Error(b.streamThrow);
    },
    abort() {},
  };
}

export function storeFile(sc) {
  const s = sc.store;
  const data = {
    version: 2,
    providers: s.providers.map((p) => ({
      id: p.id, presetId: p.presetId, name: p.id, protocol: p.protocol, baseURL: p.baseURL,
      fullUrl: false, defaultModel: p.defaultModel ?? '', models: [],
      ...(p.modelMap ? { modelMap: p.modelMap } : {}),
      enabled: p.enabled !== false,
      keys: p.keys.map((k, i) => ({ id: `k${i}`, secret: Buffer.from(k).toString('base64'), encryption: 'none', masked: '****', createdAt: 1 })),
      createdAt: 1, updatedAt: 1,
    })),
    ...(s.activeProviderId ? { activeProviderId: s.activeProviderId } : {}),
    routes: s.routes ?? {},
    usage: {},
  };
  return JSON.stringify(data);
}

const pick = (o) => {
  const out = {};
  for (const k of ['id', 'protocol', 'baseURL', 'fullUrl', 'defaultModel', 'apiKey', 'requiresApiKey', 'receiver', 'servedModelHeader', 'redactedHeader'])
    if (o[k] !== undefined) out[k] = o[k];
  return out;
};

const records = [];
for (const sc of spec.scenarios) {
  const ev = [];
  const log = (k, v) => ev.push(k + ':' + (v === undefined ? 'undefined' : JSON.stringify(v)));
  let store;
  if (!sc.noStore) {
    const dir = mkdtempSync(join(tmpdir(), 'b5r-'));
    const file = join(dir, 'p.json');
    writeFileSync(file, storeFile(sc));
    store = new ProviderStore({ filePath: file, cipher: plaintextCipher, now: () => NOW, usageFlushMs: 3_600_000, onCall: (e) => log('call', e) });
  }
  const gw = sc.gateway ? structuredClone(sc.gateway) : undefined;
  const reg = new RoutedLLMRegistry({
    store,
    envProviders: (sc.env ?? []).map((id) => fake(id)),
    overrideId: sc.override,
    gateway: gw && { resolve: (role) => (role in gw ? gw[role] : gw.default) ?? null },
    factory: (o) => { log('factory', pick(o)); return fake(o.id, o.apiKey); },
    onError: (m, e) => log('onError', m + ' ' + (e?.message ?? e)),
    onCall: (e) => log('log', e),
  });
  const resolveOp = (op) => (op.id !== undefined ? { provider: reg.get(op.id) } : reg.resolve(op.role ?? 'chat'));
  for (const op of sc.ops) {
    try {
      switch (op.op) {
        case 'resolve': {
          const r = reg.resolve(op.role ?? 'chat');
          log('resolve', r ? { id: r.provider.id, ...(r.model !== undefined ? { model: r.model } : {}) } : null);
          break;
        }
        case 'list': log('list', reg.list().map((p) => p.id)); break;
        case 'setActive': store.setActive(op.id ?? undefined); log('setActive', op.id); break;
        case 'setGateway': gw[op.role] = op.value; log('setGateway', op.role); break;
        case 'chat': case 'chatId': {
          const r = resolveOp(op);
          try { log('chat', await r.provider.chat(op.req)); } catch (e) { log('chatErr', e.message); }
          break;
        }
        case 'stream': case 'streamId': {
          const r = resolveOp(op);
          try { for await (const c of r.provider.stream(op.req)) log('chunk', c); } catch (e) { log('streamErr', e.message); }
          break;
        }
        default: throw new Error('bad op ' + op.op);
      }
    } catch (e) {
      log('opErr', String(e?.message ?? e));
    }
  }
  if (store) { log('usage', store.usage()); log('views', store.list()); }
  records.push({ name: sc.name, events: ev });
}
const out = join(root, 'apps/desktop-go/internal/ai/providers/testdata/parity/b5_router.json.gz');
writeFileSync(out, gzipSync(JSON.stringify(records, null, 1)));
console.log(`recorded ${records.length} scenarios, ${records.reduce((n, r) => n + r.events.length, 0)} events → ${out}`);
process.exit(0);
