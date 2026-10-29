#!/usr/bin/env node
/**
 * Batch 5 chat parity recorder (item 4): drives the real chatContext.ts (estimateTokens /
 * fitMessagesToBudget) and ChatFacade.ts (pick / buildRequest / runAgent / tap / abort) with
 * scripted fake LLMProviders per scripts/parity/b5-chat-scenarios.json. Records requests seen by
 * providers (signal dropped), returned values / error messages, yielded chunks, emitted events
 * and abort targets. Random reqIds are recorded as "<rand>"; Date.now is pinned.
 * The Go replay (internal/ai/sdk/facade/chat_parity_test.go) must match.
 *
 * Usage: node scripts/parity/record-b5-chat.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { register } from 'tsx/esm/api';

register();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sdk = (p) => import(pathToFileURL(join(root, 'packages/ai-sdk/src', p)).href);
const { estimateTokens, fitMessagesToBudget } = await sdk('facade/chatContext.ts');
const { createChatFacade } = await sdk('facade/ChatFacade.ts');
// ServiceKey 身份随模块实例不同；按 defineService 的名字匹配（'ctx.llm' / 'ctx.tools'）
const keyName = (k) => (typeof k === 'symbol' ? k.description : (k?.id ?? k?.name ?? k?.key ?? String(k)));
const spec = JSON.parse(readFileSync(join(root, 'scripts/parity/b5-chat-scenarios.json'), 'utf8'));
Date.now = () => 1_700_000_000_000;

const given = new Set();
const norm = (req) => {
  const { signal, ...rest } = req;
  const o = JSON.parse(JSON.stringify(rest));
  if (!given.has(o.reqId)) o.reqId = '<rand>';
  return o;
};

async function runScenario(sc) {
  const log = [];
  const mk = (p) => {
    const base = {
      id: p.id,
      async chat(req) {
        log.push({ ev: 'chat', id: p.id, req: norm(req) });
        return { reqId: req.reqId, provider: p.id, model: req.model, content: 'ok:' + p.id, finishReason: 'stop' };
      },
      async *stream(req) {
        log.push({ ev: 'stream', id: p.id, req: norm(req) });
        for (const c of p.stream ?? []) {
          await null;
          yield structuredClone(c);
        }
        if (p.streamThrow) throw new Error(p.streamThrow);
      },
      abort(reqId) {
        log.push({ ev: 'abort', id: p.id, reqId });
      },
    };
    if (p.withTools) {
      base.withTools = (defs) => {
        log.push({ ev: 'withTools', id: p.id, tools: defs.map((d) => d.name) });
        return {
          chat: async (req) => {
            log.push({ ev: 'tools.chat', id: p.id, req: norm(req) });
            return { reqId: req.reqId, provider: p.id, model: req.model, content: 'tools:' + p.id, finishReason: 'stop' };
          },
          stream: (req) => {
            log.push({ ev: 'tools.stream', id: p.id });
            return base.stream(req);
          },
        };
      };
    }
    return base;
  };
  const provs = (sc.providers ?? []).map(mk);
  const byId = new Map(provs.map((p) => [p.id, p]));
  const reg = {
    get: (id) => byId.get(id),
    list: () => provs,
    resolve: (role) => {
      const r = sc.resolve?.[role];
      if (!r) return undefined;
      return { provider: byId.get(r.id), ...(r.model !== undefined ? { model: r.model } : {}) };
    },
  };
  const toolReg = { list: () => (sc.tools ?? []).map((name) => ({ name, description: name, parameters: {} })) };
  const ctx = {
    inject: (key) => (String(keyName(key)).includes('ctx.llm') ? (sc.noRegistry ? undefined : reg) : String(keyName(key)).includes('ctx.tools') ? (sc.tools ? toolReg : undefined) : undefined),
    on: () => () => {},
    emit: (event, payload) => {
      const p = JSON.parse(JSON.stringify(payload));
      if (!given.has(p.message.id)) p.message.id = p.message.sessionId = '<rand>';
      log.push({ ev: 'emit', event, payload: p });
    },
  };
  const chat = createChatFacade(ctx);
  for (const c of sc.calls) {
    given.clear();
    if (c.opts?.reqId !== undefined) given.add(c.opts.reqId);
    const entry = { op: c.op };
    try {
      if (c.op === 'abort') {
        chat.abort(c.reqId);
      } else if (c.op === 'sendMessage' || c.op === 'agent') {
        const res = await chat[c.op](structuredClone(c.opts));
        entry.result = JSON.parse(JSON.stringify(res));
        if (!given.has(entry.result.reqId)) entry.result.reqId = '<rand>';
      } else {
        entry.chunks = [];
        for await (const ch of chat[c.op](structuredClone(c.opts))) entry.chunks.push(ch);
      }
    } catch (e) {
      entry.error = e.message;
    }
    log.push(entry);
  }
  return { name: sc.name, log };
}

const out = {
  tokens: spec.tokens.map((t) => estimateTokens(t)),
  fit: spec.fit.map((f) => fitMessagesToBudget(f.messages, f.budget)),
  facade: [],
};
for (const sc of spec.facade) out.facade.push(await runScenario(sc));
const dst = join(root, 'apps/desktop-go/internal/ai/sdk/facade/testdata/parity/b5_chat.json.gz');
writeFileSync(dst, gzipSync(JSON.stringify(out)));
console.log(`b5-chat: ${out.tokens.length} tokens, ${out.fit.length} fit, ${out.facade.length} facade scenarios -> ${dst}`);
