#!/usr/bin/env node
/**
 * Batch 5 AI-runtime parity recorder (docs/design/migrate-2.0.5-go.md, D-B5-*).
 * Drives the real AiSdkLlmProvider (packages/ai-runtime) with a scripted LanguageModelV4
 * (no network) per scripts/parity/b5-aisdk-scenarios.json and records, per scenario:
 *   calls   – every doStream/doGenerate call options object (JSON.stringify, abortSignal dropped)
 *   chunks  – ChatChunks emitted by stream() (mode=stream) or the ChatResponse (mode=chat)
 *   execs   – tool executions {name,input,ctx} (ctx without signal), in start order
 *   error   – thrown error message (if the iterator / promise rejected)
 * The Go replay test (internal/ai/runtime/aisdk) must match byte for byte.
 *
 * Usage: node scripts/parity/record-b5-aisdk.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { register } from 'tsx/esm/api';
import { APICallError } from '@ai-sdk/provider';

register();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rt = (p) => import(pathToFileURL(join(root, 'packages/ai-runtime/src', p)).href);
const { AiSdkLlmProvider } = await rt('ai-sdk/AiSdkLlmProvider.ts');
const scenarios = JSON.parse(readFileSync(join(root, 'scripts/parity/b5-aisdk-scenarios.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeError(t) {
  if (t.plain) return new Error(t.message);
  return new APICallError({
    message: t.message, url: 'http://mock/v1', requestBodyValues: {}, statusCode: t.statusCode,
    responseHeaders: t.headers, responseBody: t.data ? JSON.stringify(t.data) : undefined, data: t.data,
  });
}

function streamOf(parts) {
  return new ReadableStream({
    async start(c) { for (const p of parts) { c.enqueue(structuredClone(p)); await sleep(0); } c.close(); },
  });
}

function generateOf(parts) {
  // stream parts → doGenerate content (the same step script feeds both entry points)
  const content = []; let finish; const open = new Map();
  for (const p of parts) {
    if (p.type === 'text-start' || p.type === 'reasoning-start') { const c = { type: p.type === 'text-start' ? 'text' : 'reasoning', text: '' }; open.set(p.id + p.type[0], c); content.push(c); }
    else if (p.type === 'text-delta' || p.type === 'reasoning-delta') open.get(p.id + p.type[0]).text += p.delta;
    else if (p.type === 'tool-call') content.push(structuredClone(p));
    else if (p.type === 'finish') finish = p;
  }
  return { content, finishReason: finish.finishReason, usage: finish.usage, warnings: [] };
}

function model(sc, calls, modelId) {
  let i = 0;
  const next = (opts) => {
    const { abortSignal, ...rest } = opts;
    calls.push(JSON.stringify({ modelId, ...rest }));
    const step = sc.steps[i++];
    if (!step) throw new Error('script exhausted');
    if (step.throw) throw makeError(step.throw);
    return step;
  };
  return {
    specificationVersion: 'v4', provider: 'mock', modelId, supportedUrls: {},
    async doStream(opts) { const s = next(opts); return { stream: streamOf(s.parts), response: { headers: s.headers } }; },
    async doGenerate(opts) { const s = next(opts); return { ...generateOf(s.parts), response: { headers: s.headers } }; },
  };
}

function toolDefs(sc, execs, ctl) {
  return (sc.tools ?? []).map((t) => ({
    name: t.name, description: t.description, input: t.input, requiresWorkspace: t.requiresWorkspace,
    async execute(input, ctx) {
      const { signal, ...rest } = ctx;
      execs.push(JSON.stringify({ name: t.name, input, ctx: rest }));
      const b = t.behavior;
      if (b.delayMs) await sleep(b.delayMs);
      switch (b.kind) {
        case 'echo': return input;
        case 'return': return b.value;
        case 'undefined': return undefined;
        case 'throw': throw new Error(b.message);
        case 'bigstring': return 'x'.repeat(b.size);
        case 'wait-abort':
          ctl.onToolStart?.();
          await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted by user'))));
      }
    },
  }));
}

const out = [];
for (const sc of scenarios) {
  const calls = [], execs = [], chunks = [];
  const o = sc.opts ?? {};
  const p = new AiSdkLlmProvider({
    id: 'prov', protocol: o.protocol, baseURL: 'http://mock/v1', apiKey: 'apiKey' in o ? o.apiKey : 'sk-test',
    requiresApiKey: o.requiresApiKey, defaultModel: o.defaultModel ?? 'default-model', modelMap: o.modelMap,
    thinking: o.thinking, maxSteps: o.maxSteps, servedModelHeader: o.servedModelHeader, redactedHeader: o.redactedHeader,
  });
  p.modelFactory = (id) => model(sc, calls, id);
  const ctl = {};
  if (sc.name.startsWith('abort')) ctl.onToolStart = () => setTimeout(() => p.abort(sc.request.reqId), 5);
  const target = sc.tools ? p.withTools(toolDefs(sc, execs, ctl)) : p;
  const rec = { name: sc.name };
  try {
    if (sc.mode === 'chat') rec.result = JSON.stringify(await target.chat(structuredClone(sc.request)));
    else for await (const c of target.stream(structuredClone(sc.request))) chunks.push(JSON.stringify(c));
  } catch (e) { rec.error = e instanceof Error ? e.message : String(e); }
  Object.assign(rec, { calls, execs, chunks });
  out.push(rec);
  console.log(sc.name, calls.length, chunks.length, rec.error ?? '');
}
writeFileSync(join(root, 'apps/desktop-go/internal/ai/runtime/aisdk/testdata/b5_aisdk.json.gz'), gzipSync(JSON.stringify(out, null, 1)));
