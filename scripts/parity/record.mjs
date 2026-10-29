#!/usr/bin/env node
/**
 * Golden parity recorder for the Go migration (docs/design/migrate-2.0.5-go.md §parity).
 *
 * Runs the Node gateway (packages/gateway/src, loaded through tsx) on a fixed set
 * of inputs and writes every input + output to JSON fixtures. The Go side
 * (apps/desktop-go/internal/gateway/parity_test.go) replays the same inputs and
 * diffs the outputs after normalisation (scripts/parity/normalize.mjs rules, also
 * implemented in Go): generated ids `<prefix>_nomi_<time36><rand6>` and
 * wall-clock seconds (`created`, `created_at`) are masked; everything else must
 * match byte for byte, including key order and streamed chunk boundaries.
 *
 * Sections:
 *   request  – decode(from) → encode(to) for every wire pair, ± upstream model,
 *              ± reasoningPassback, plus callIdSeed of the body
 *   stream   – upstream SSE text → downstream SSE, whole and split every 7 chars
 *   json     – upstream JSON → downstream SSE (jsonToSse) and JSON (jsonToJson)
 *   e2e      – the real GatewayServer against a local mock upstream per protocol,
 *              recording the raw streamed chunks the client receives
 *
 * Usage: node scripts/parity/record.mjs [--only request,stream,json,e2e]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { register } from 'tsx/esm/api';

register();

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'apps/desktop-go/internal/gateway/testdata/parity');
const gw = (p) => import(pathToFileURL(join(root, 'packages/gateway', p)).href);

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : null;
})();
const want = (s) => !only || only.has(s);

const WIRES = ['messages', 'responses', 'chat', 'gemini'];

const { requestCases, extraSse, extraJson } = await import('./cases.mjs');
const cases = await gw('tests/fixtures/cases.ts');
const req = await gw('src/request/index.ts');
const ids = await gw('src/models/rules/response/callIds.ts');
const stream = await gw('src/stream/index.ts');

function write(name, data) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(data, null, 1) + '\n');
  const n = Array.isArray(data.cases) ? data.cases.length : 0;
  console.log(`wrote ${name}.json (${n} cases)`);
}

/* -------------------------------- request -------------------------------- */
if (want('request')) {
  const bodies = {
    messages: [...cases.messagesBodies, ...requestCases.messages],
    responses: [...cases.responsesBodies, ...requestCases.responses],
    chat: [...cases.chatBodies, ...requestCases.chat],
    gemini: requestCases.gemini,
  };
  const out = [];
  for (const from of WIRES) {
    bodies[from].forEach((b, i) => {
      // 经 JSON 往返：Go 读到的就是这份文本，键序 / 数值与 Node 看到的完全一致
      const input = JSON.stringify(b);
      const body = JSON.parse(input);
      const seed = ids.callIdSeed(body);
      for (const to of WIRES) {
        for (const model of [undefined, 'up-model']) {
          for (const reasoningPassback of to === 'chat' ? [false, true] : [false]) {
            const opts = {
              upstreamModel: model,
              reasoningPassback,
              ...(from === 'gemini' ? { model: 'g-model', stream: i % 2 === 1 } : {}),
            };
            out.push({
              name: `${from}#${i}→${to}${model ? '+model' : ''}${reasoningPassback ? '+passback' : ''}`,
              from,
              to,
              input,
              opts: { upstreamModel: model ?? null, reasoningPassback, model: opts.model ?? null, stream: !!opts.stream },
              seed,
              output: JSON.stringify(req.convertRequest(from, to, JSON.parse(input), opts)),
            });
          }
        }
      }
    });
  }
  write('request', { cases: out });
}

/* --------------------------------- stream -------------------------------- */
/** never cut inside a UTF-16 surrogate pair, so Go (UTF-8) sees the same pieces */
const safeCut = (t, k) => {
  const c = t.charCodeAt(k - 1);
  return c >= 0xd800 && c <= 0xdbff ? k + 1 : k;
};
function splitUnits(t, n) {
  const out = [];
  for (let k = 0; k < t.length; ) {
    const e = Math.min(t.length, safeCut(t, k + n));
    out.push(t.slice(k, e));
    k = e;
  }
  return out;
}
const convOpts = { model: 'fallback', customTools: new Set(['apply_patch']) };

if (want('stream')) {
  const out = [];
  for (const from of Object.keys(cases.upstreamSse)) {
    [...cases.upstreamSse[from], ...(extraSse[from] ?? [])].forEach((text, i) => {
      for (const to of WIRES) {
        const c = stream.createStreamConverter(from, to, convOpts);
        const whole = [c.push(text), c.end()];
        const s = stream.createStreamConverter(from, to, convOpts);
        const chunks = [];
        const inChunks = splitUnits(text, 7);
        for (const piece of inChunks) chunks.push(s.push(piece));
        chunks.push(s.end());
        const f = stream.createStreamConverter(from, to, convOpts);
        const half = text.slice(0, safeCut(text, Math.floor(text.length / 2)));
        const failed = [f.push(half), f.fail('socket hang up')];
        out.push({ name: `${from}#${i}→${to}`, from, to, input: text, inChunks, half, whole, split7: chunks, failHalf: failed });
      }
    });
  }
  write('stream', { opts: { model: 'fallback', customTools: ['apply_patch'] }, cases: out });
}

/* ---------------------------------- json --------------------------------- */
if (want('json')) {
  const out = [];
  for (const from of Object.keys(cases.upstreamJson)) {
    [...cases.upstreamJson[from], ...(extraJson[from] ?? [])].forEach((b, i) => {
      const input = JSON.stringify(b);
      for (const to of WIRES) {
        const sse = stream.jsonToSse(from, to, JSON.parse(input), convOpts);
        const r = stream.jsonToJson(from, to, JSON.parse(input), convOpts);
        out.push({
          name: `${from}#${i}→${to}`,
          from,
          to,
          input,
          sse,
          json: { ok: r.ok, status: r.status, body: JSON.stringify(r.body) },
        });
      }
    });
  }
  write('json', { opts: { model: 'fallback', customTools: ['apply_patch'] }, cases: out });
}

if (want('e2e')) {
  const { recordE2E } = await import('./e2e.mjs');
  write('e2e', await recordE2E({ gw, cases }));
}
