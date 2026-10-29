#!/usr/bin/env node
/**
 * B5 vendor-protocol adapter parity recorder (docs/design/migrate-2.0.5-go.md §3.4).
 *
 * Drives Node's real AI runtime wiring (AiSdkLlmProvider → ai streamText /
 * generateText → @ai-sdk/openai-compatible | openai .responses() | anthropic
 * .messages()) against a scripted local HTTP server. The language model the
 * runtime builds is wrapped so every doStream / doGenerate call records:
 *   options   – the LanguageModelV4CallOptions ai handed to the provider
 *   request   – what reached the wire (method, path, headers, body text)
 *   provider  – stream parts / generate result / thrown error
 * plus the ai-level outcome (fullStream error part, thrown error).
 * Go (internal/ai/llm/*) replays each call: same options, same scripted
 * response → request and parts must match exactly.
 *
 * Usage: node scripts/parity/record-b5-llm.mjs
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

register();
// Workspace packages resolve to their sources (no dist build needed).
const srcHook = `export async function resolve(s, c, n) {
  const m = /^@nomi-ai\\/([\\w-]+)$/.exec(s);
  if (m) return n(new URL('../../packages/' + m[1] + '/src/index.ts', ${JSON.stringify(import.meta.url)}).href, c);
  return n(s, c);
}`;
(await import('node:module')).register('data:text/javascript,' + encodeURIComponent(srcHook));
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'apps/desktop-go/internal/ai/llm/testdata');
// Each scenario list writes its own golden file; B5_ONLY=<file> re-records just one.
const only = process.env.B5_ONLY;
const { AiSdkLlmProvider } = await import(
  pathToFileURL(join(root, 'packages/ai-runtime/src/ai-sdk/AiSdkLlmProvider.ts')).href
);
const ai = await import('ai');

// ---------- serialization ----------
const TRANSPORT = new Set(['host', 'connection', 'content-length', 'accept', 'accept-language',
  'sec-fetch-mode', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'date']);
const filterHeaders = (h) => {
  if (!h) return h;
  const o = {};
  for (const k of Object.keys(h).sort()) if (!TRANSPORT.has(k)) o[k] = h[k];
  return o;
};
function errJSON(e) {
  if (e == null || typeof e !== 'object') return e;
  if (!(e instanceof Error) && e.name !== 'AbortError') return plain(e);
  const n = e.name;
  if (n === 'AI_APICallError') {
    const o = { name: n, message: e.message, url: e.url };
    if (e.statusCode !== undefined) o.statusCode = e.statusCode;
    if (e.responseBody !== undefined) o.responseBody = e.responseBody;
    o.isRetryable = e.isRetryable;
    if (e.data !== undefined) o.data = plain(e.data);
    if (e.responseHeaders !== undefined) o.responseHeaders = filterHeaders(e.responseHeaders);
    return o;
  }
  if (n === 'AI_TypeValidationError') return { name: n, value: plain(e.value) };
  if (n === 'AI_JSONParseError') return { name: n, text: e.text };
  if (n === 'AI_InvalidResponseDataError') {
    const o = { name: n, message: e.message };
    if (e.data !== undefined) o.data = plain(e.data);
    return o;
  }
  if (n === 'AI_RetryError') return { name: n, message: e.message, reason: e.reason, errors: e.errors.map(errJSON) };
  return { name: n, message: e.message };
}
function plain(v) {
  return JSON.parse(JSON.stringify(v, function (k, x) {
    const orig = this[k];
    if (orig instanceof Error || (orig && orig.name === 'AbortError' && typeof orig.message === 'string' && orig !== v)) return errJSON(orig);
    if (orig instanceof Uint8Array) return { __bytes: Buffer.from(orig).toString('base64') };
    if (orig instanceof URL) return { __url: orig.href };
    if (orig instanceof Date) return { __date: orig.getTime() };
    return x;
  }) ?? 'null');
}
function optionsJSON(o) {
  const { abortSignal, headers, ...rest } = o;
  const out = plain(rest);
  if (headers !== undefined) out.headers = Object.entries(headers).map(([k, v]) => [k, v === undefined ? null : v]);
  return out;
}

// ---------- scripted server ----------
let queue = [];
let seen = [];
const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    seen.push({ method: req.method, path: req.url, headers: filterHeaders(req.headers), body });
    const step = queue.shift() ?? { status: 500, body: 'no scripted step' };
    res.writeHead(step.status ?? 200, step.headers ?? {});
    for (const c of step.chunks ?? (step.body !== undefined ? [step.body] : [])) {
      res.write(c);
      await new Promise((r) => setTimeout(r, 2));
    }
    if (step.end === 'destroy') res.socket.destroy();
    else if (step.end === 'hang') { /* keep open; client aborts */ res.on('close', () => res.destroy()); }
    else res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- recording model wrapper ----------
function wrap(model, calls, sc) {
  return new Proxy(model, {
    get(t, p, r) {
      if (p === 'doStream') return async (o) => {
        const call = { kind: 'stream', options: optionsJSON(o) };
        calls.push(call);
        try {
          const res = await t.doStream(o);
          call.requestBody = res.request?.body;
          call.responseHeaders = filterHeaders(res.response?.headers);
          const parts = [];
          call.parts = parts;
          const reader = res.stream.getReader();
          const pass = new ReadableStream({
            async pull(c) {
              try {
                const { done, value } = await reader.read();
                if (done) return c.close();
                parts.push(plain(value));
                if (sc.abortAfterParts && parts.length === sc.abortAfterParts) {
                  // Abort, then observe what the provider stream does next.
                  sc.abort();
                  try {
                    for (;;) {
                      const n = await reader.read();
                      if (n.done) break;
                      parts.push(plain(n.value));
                    }
                  } catch (e) {
                    call.streamError = errJSON(e);
                  }
                  try { c.enqueue(value); c.close(); } catch { /* consumer already cancelled */ }
                  return;
                }
                c.enqueue(value);
              } catch (e) {
                call.streamError = errJSON(e);
                c.error(e);
              }
            },
          });
          return { ...res, stream: pass };
        } catch (e) {
          call.thrown = errJSON(e);
          throw e;
        }
      };
      if (p === 'doGenerate') return async (o) => {
        const call = { kind: 'generate', options: optionsJSON(o) };
        calls.push(call);
        if (sc.abortBeforeGenerate) setTimeout(() => sc.abort(), 50);
        let res;
        try {
          res = await t.doGenerate(o);
          call.result = plain({
            content: res.content, finishReason: res.finishReason, usage: res.usage,
            providerMetadata: res.providerMetadata, warnings: res.warnings,
            requestBody: res.request?.body,
            response: { id: res.response?.id, timestamp: res.response?.timestamp, modelId: res.response?.modelId,
              headers: filterHeaders(res.response?.headers), body: res.response?.body },
          });
        } catch (e) {
          call.thrown = errJSON(e);
          throw e;
        }
        return res;
      };
      return Reflect.get(t, p, r);
    },
  });
}

// ---------- scenarios ----------
const sse = (evs) => evs.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`));
const SSE_H = { 'content-type': 'text/event-stream' };
const JSON_H = { 'content-type': 'application/json' };
const json = (status, v, h = {}) => ({ status, headers: { ...JSON_H, ...h }, body: typeof v === 'string' ? v : JSON.stringify(v) });

const scenarios = [];
const add = (s) => scenarios.push(s);
import { compatibleScenarios } from './b5-llm-scenarios.mjs';
for (const s of compatibleScenarios({ sse, SSE_H, json })) add(s);
import { responsesScenarios } from './b5-llm-openai-scenarios.mjs';
for (const s of responsesScenarios({ sse, SSE_H, json })) add({ ...s, outFile: 'b5-llm-openai-responses.json' });

// ---------- run ----------
const results = {};
for (const sc of scenarios) {
  const file = sc.outFile ?? 'b5-llm.json';
  if (only && only !== file) continue;
  queue = structuredClone(sc.responses);
  seen = [];
  const calls = [];
  const opts = {
    id: sc.id ?? 'acme',
    protocol: sc.protocol,
    baseURL: base + (sc.basePath ?? '/v1'),
    apiKey: sc.apiKey ?? 'sk-test',
    ...(sc.headers ? { headers: sc.headers } : {}),
    ...(sc.userAgent ? { userAgent: sc.userAgent } : {}),
    ...(sc.thinking ? { thinking: true } : {}),
    defaultModel: sc.model ?? 'm-1',
  };
  const prov = new AiSdkLlmProvider(opts);
  const orig = prov.modelFactory;
  prov.modelFactory = (id) => wrap(orig(id), calls, sc);
  const out = { name: sc.name, protocol: sc.protocol, settings: opts, responses: sc.responses,
    abortAfterParts: sc.abortAfterParts, abortBeforeGenerate: sc.abortBeforeGenerate, maxRetries: sc.maxRetries };
  const ac = new AbortController();
  sc.abort = () => ac.abort();
  const model = prov.modelFactory(prov.resolveModel({ model: sc.model ?? 'm-1' }));
  const common = {
    model,
    ...(sc.instructions ? { instructions: sc.instructions } : {}),
    messages: sc.messages,
    ...(sc.settingsCall ?? {}),
    abortSignal: ac.signal,
    ...(sc.maxRetries !== undefined ? { maxRetries: sc.maxRetries } : {}),
    ...(sc.thinking ? { providerOptions: prov.opts && thinkingFor(sc.protocol, opts.id) } : {}),
    ...(sc.providerOptions ? { providerOptions: sc.providerOptions } : {}),
    ...(sc.tools ? { tools: Object.fromEntries(sc.tools.map((t) => [t.name, ai.tool({ description: t.description, inputSchema: ai.jsonSchema(t.inputSchema) })])) } : {}),
    ...(sc.toolChoice ? { toolChoice: sc.toolChoice } : {}),
  };
  try {
    if (sc.call === 'generate') {
      const r = await ai.generateText(common);
      out.ai = { text: r.text, finishReason: r.finishReason };
    } else {
      const r = ai.streamText(common);
      const errs = [];
      for await (const p of r.fullStream) if (p.type === 'error') errs.push(errJSON(p.error));
      out.ai = { errors: errs };
    }
  } catch (e) {
    out.ai = { thrown: errJSON(e) };
  }
  await new Promise((r) => setTimeout(r, 20));
  out.calls = calls.map((c, i) => ({ ...c, request: seen[i] }));
  (results[file] ??= []).push(out);
  console.log(sc.name, calls.length, 'calls');
}
function thinkingFor(protocol, id) {
  if (protocol === 'anthropic') return { anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } };
  if (protocol === 'openai-responses') return { openai: { reasoningEffort: 'medium' } };
  return { [id]: { reasoningEffort: 'medium' } };
}
server.close();
for (const [file, rs] of Object.entries(results)) {
  const outFile = join(outDir, file);
  writeFileSync(outFile, JSON.stringify({ node: process.version, ai: '7.0.136', scenarios: rs }, null, 1) + '\n');
  console.log('wrote', rs.length, 'scenarios →', outFile);
}
