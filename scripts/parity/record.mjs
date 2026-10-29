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
 *   fixes    – response fixer through converters, same-wire passthrough
 *              (ChatStreamPatcher / repetition), TerminalWatch, passthroughFail,
 *              patchChatJson and jsonToJson with fixes
 *   e2e      – the real GatewayServer against a local mock upstream per protocol,
 *              recording the raw streamed chunks the client receives
 *
 * Usage: node scripts/parity/record.mjs [--only request,stream,json,fixes,spec,e2e]
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

/* --------------------------------- fixes -------------------------------- */
if (want('fixes')) {
  const fixerMod = await gw('src/models/rules/response/fixer.ts');
  const pt = await gw('src/stream/passthrough.ts');
  const cp = await gw('src/stream/chatPatch.ts');
  const { fixTexts } = await import('./cases.mjs');
  const mkOpts = () => ({
    toolNames: new Map([['mapped_weather', 'get_weather']]),
    textTools: new Set(['get_weather', 'read_file']),
    repetition: true,
    notes: [],
    callIds: new ids.CallIds('seed1'),
  });
  const chatSse = (fx) => {
    const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'up' };
    const ch = (delta, finish = null) =>
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let s = ch({ role: 'assistant', content: '' });
    for (const r of splitUnits(fx.think ?? '', 9)) s += ch({ reasoning_content: r });
    for (const t of splitUnits(fx.text ?? '', 9)) s += ch({ content: t });
    (fx.tools ?? []).forEach((t, i) => {
      s += ch({ tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: t.name, arguments: '' } }] });
      s += ch({ tool_calls: [{ index: i, function: { arguments: t.args } }] });
    });
    s += ch({}, fx.tools?.length ? 'tool_calls' : 'stop');
    return s + 'data: [DONE]\n\n';
  };
  const inputs = {};
  for (const w of WIRES) {
    inputs[w] = fixTexts.map((fx) => {
      const chat = chatSse(fx);
      if (w === 'chat') return chat;
      const c = stream.createStreamConverter('chat', w, { model: 'up' });
      return c.push(chat) + c.end();
    });
  }
  const fixer = [];
  const passthrough = [];
  const terminal = [];
  for (const from of WIRES) {
    inputs[from].forEach((text, i) => {
      const inChunks = splitUnits(text, 7);
      for (const to of WIRES) {
        const o = mkOpts();
        const c = stream.createStreamConverter(from, to, { ...convOpts, fixes: o });
        const chunks = [];
        for (const piece of inChunks) {
          chunks.push(c.push(piece));
          if (c.stopped) break;
        }
        chunks.push(c.end());
        fixer.push({ name: `${from}#${i}→${to}`, from, to, input: text, inChunks, out: chunks, stopped: c.stopped, notes: o.notes });
      }
      for (const variant of ['default', 'noChatStream', 'noFixes']) {
        const o = variant === 'noFixes' ? { notes: [] } : { ...mkOpts(), ...(variant === 'noChatStream' ? { chatStream: false } : {}) };
        const p = pt.createPassthrough(from, o);
        if (!p) {
          passthrough.push({ name: `${from}#${i}/${variant}`, wire: from, variant, input: text, inChunks, nil: true });
          continue;
        }
        const chunks = [];
        for (const piece of inChunks) {
          chunks.push(p.push(piece));
          if (p.stopped) break;
        }
        chunks.push(p.end());
        passthrough.push({ name: `${from}#${i}/${variant}`, wire: from, variant, input: text, inChunks, out: chunks, stopped: p.stopped, notes: o.notes });
      }
      const half = text.slice(0, safeCut(text, Math.floor(text.length / 2)));
      for (const [k, t] of [['whole', text], ['half', half], ['noTail', text.replace(/\n\n$/, '')]]) {
        const tw = new pt.TerminalWatch(from);
        for (const piece of splitUnits(t, 7)) tw.push(piece);
        terminal.push({ name: `${from}#${i}/${k}`, wire: from, input: t, terminated: tw.terminated });
      }
    });
  }
  const fail = WIRES.map((w) => ({ wire: w, out: pt.passthroughFail(w, 'upstream reset') }));
  const json = [];
  fixTexts.forEach((fx, i) => {
    const msg = { role: 'assistant', content: fx.text ?? '' };
    if (fx.tools?.length)
      msg.tool_calls = fx.tools.map((t, k) => ({ id: `call_${k}`, type: 'function', function: { name: t.name, arguments: t.args } }));
    const body = { id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'up', choices: [{ index: 0, message: msg, finish_reason: fx.tools?.length ? 'tool_calls' : 'stop' }] };
    const input = JSON.stringify(body);
    const o = mkOpts();
    const patched = cp.patchChatJson(JSON.parse(input), o);
    const conv = {};
    for (const to of WIRES) {
      const o2 = mkOpts();
      const r = stream.jsonToJson('chat', to, JSON.parse(input), { ...convOpts, fixes: o2 });
      conv[to] = { ok: r.ok, status: r.status, body: JSON.stringify(r.body), notes: o2.notes };
    }
    json.push({ name: `json#${i}`, input, patched: JSON.stringify(patched), notes: o.notes, conv });
  });
  write('fixes', {
    opts: { toolNames: { mapped_weather: 'get_weather' }, textTools: ['get_weather', 'read_file'], seed: 'seed1' },
    cases: fixer,
    passthrough,
    terminal,
    fail,
    json,
  });
}

/* ---------------------------------- spec --------------------------------- */
if (want('spec')) {
  const spec = await gw('src/spec/index.ts');
  const texts = [];
  for (const from of Object.keys(cases.upstreamSse))
    for (const text of [...cases.upstreamSse[from], ...(extraSse[from] ?? [])]) {
      texts.push([from, text]);
      for (const to of WIRES) {
        const c = stream.createStreamConverter(from, to, convOpts);
        const out = c.push(text) + c.end();
        texts.push([to, out]);
        texts.push([to, out.slice(0, safeCut(out, Math.floor(out.length / 2)))]);
        const f = stream.createStreamConverter(from, to, convOpts);
        texts.push([to, f.push(text.slice(0, safeCut(text, Math.floor(text.length / 3)))) + f.fail('boom')]);
      }
    }
  const broken = {
    chat: ['data: {"choices":[{"delta":{"content":[1]},"finish_reason":""}]}\n\n', 'data: nope\n\ndata: {"x":1}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":{}}}]},"finish_reason":"weird"}]}\n\ndata: {"choices":[]}\n\ndata: {"choices":[{}]}\n\n'],
    messages: ['event: content_block_delta\ndata: {"index":3}\n\n', 'data: {"type":"message_start","message":{"id":"m"}}\n\ndata: {"type":"content_block_start","index":1}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"bogus"}\n\ndata: {"type":"message_stop"}\n\ndata: {"type":"ping"}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'],
    responses: ['data: {"type":"response.output_text.delta","item_id":"x"}\n\ndata: {"type":"response.output_item.done","sequence_number":1,"item":{"type":"message","id":"y","content":[{"type":"output_text"}]}}\n\ndata: {"type":"response.completed","sequence_number":2,"response":{"output":[{"type":"function_call"},{"type":7}]}}\n\ndata: {"type":"x"}\n\n'],
    gemini: ['data: {"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}]}\n\ndata: {"candidates":[]}\n\ndata: {"usageMetadata":{}}\n\n', 'data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n', 'data: {"foo":1}\n\n'],
  };
  for (const [w, list] of Object.entries(broken)) for (const t of list) texts.push([w, t]);
  const out = texts.map(([wire, text], i) => {
    const evs = spec.parseSpecEvents(text);
    const s = spec.specOf(wire);
    return {
      name: `spec#${i}/${wire}`,
      wire,
      input: text,
      violations: s.validate(evs),
      flags: evs.map((e) => `${+s.isTerminal(e)}${+s.isContent(e)}${+s.isError(e)}`).join(','),
    };
  });
  write('spec', { cases: out });
}

if (want('e2e')) {
  const { recordE2E } = await import('./e2e.mjs');
  write('e2e', await recordE2E({ gw, cases }));
}
