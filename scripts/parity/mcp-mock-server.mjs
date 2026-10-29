#!/usr/bin/env node
// MCP mock server for Go↔Node parity (batch 5 MCP). Deterministic responses; logs the full wire both ways.
//   stdio: node mcp-mock-server.mjs stdio <variant> [extra args…]   — wire log → $MCP_WIRE_LOG (JSONL)
//   http : node mcp-mock-server.mjs http                              — prints {"port":N} then serves:
//          /<variant>/mcp  streamable HTTP (variant modern|legacy|sseresp|slowinit|err404|badct)
//          /<variant>/sse  SSE transport (GET stream + POST /<variant>/messages)
//          GET /__log?reset=1  → wire log (JSON array) and clears it
// variants: modern (server/discover ok) | legacy (discover → -32601, initialize) | slowinit (never answers init)
import http from 'node:http';
import fs from 'node:fs';

const SERVER_INFO = { name: 'nomi-mock-mcp', version: '0.0.1' };
const TOOLS = [
  { name: 'echo', title: 'Echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'struct', inputSchema: { properties: { n: { type: 'number' } } }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always isError', inputSchema: { type: 'object' } },
  { name: 'multi', description: 'Two text parts + image', inputSchema: { type: 'object', properties: {} } },
  { name: 'pinger', description: 'Server pings the client before answering', inputSchema: { type: 'object' } },
  { name: 'unicode', description: 'Ünïcødé ✓ 🚀', inputSchema: { type: 'object', properties: { 'a b': { type: 'string' } } } },
];

function toolResult(name, args) {
  switch (name) {
    case 'echo': return { content: [{ type: 'text', text: `echo:${args?.text ?? ''}` }] };
    case 'struct': return { content: [{ type: 'text', text: '{"n":2}' }], structuredContent: { n: (args?.n ?? 1) * 2, nested: { ok: true } } };
    case 'fail': return { content: [{ type: 'text', text: 'bad thing' }, { type: 'text', text: 'second line' }], isError: true };
    case 'multi': return { content: [{ type: 'text', text: 'part1' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'text', text: 'part2' }] };
    case 'pinger': return { content: [{ type: 'text', text: 'pong-done' }] };
    case 'unicode': return { content: [{ type: 'text', text: `ü✓🚀 ${JSON.stringify(args)}` }] };
  }
  return null;
}

// handle(msg, variant, send) → reply object | undefined (no reply). send(obj) pushes a server→client message.
async function handle(msg, variant, sendServerReq) {
  const r = await handleInner(msg, variant, sendServerReq);
  const modern = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
  if (r && r.result && modern) r.result = { resultType: 'complete', ...r.result };
  return r;
}

async function handleInner(msg, variant, sendServerReq) {
  if (!('method' in msg)) return undefined; // response to server request / notification
  if (!('id' in msg)) return undefined;
  const { id, method, params } = msg;
  if (variant === 'slowinit' && (method === 'initialize' || method === 'server/discover')) return new Promise(() => {});
  if (method === 'server/discover') {
    if (variant !== 'modern' && variant !== 'sseresp') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    return { jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: false } }, instructions: 'mock instructions', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } };
  }
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    if (params?.name === 'pinger') await sendServerReq({ jsonrpc: '2.0', id: 'srv-ping-1', method: 'ping' });
    const r = toolResult(params?.name, params?.arguments);
    if (!r) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}`, data: { tool: params?.name } } };
    return { jsonrpc: '2.0', id, result: r };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const mode = process.argv[2];

if (mode === 'stdio') {
  const variant = process.argv[3] ?? 'legacy';
  const logFile = process.env.MCP_WIRE_LOG;
  const log = (e) => logFile && fs.appendFileSync(logFile, JSON.stringify(e) + '\n');
  const envKeys = Object.keys(process.env).filter((k) => k !== 'MCP_WIRE_LOG').sort();
  log({ dir: 'meta', argv: process.argv.slice(3), env: envKeys, custom: process.env.NOMI_MOCK_CUSTOM ?? null });
  const write = (obj) => { const line = JSON.stringify(obj) + '\n'; log({ dir: 'out', line }); process.stdout.write(line); };
  let pendingPing = null;
  let buf = Buffer.alloc(0);
  process.stdin.on('data', async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const line = buf.subarray(0, i).toString('utf8');
      buf = buf.subarray(i + 1);
      log({ dir: 'in', line });
      const msg = JSON.parse(line);
      if (!('method' in msg) && msg.id === 'srv-ping-1' && pendingPing) { pendingPing(); pendingPing = null; continue; }
      if (msg.method === 'tools/call' && msg.params?.name === 'crash') { process.exit(3); }
      handle(msg, variant, (req) => new Promise((res) => { pendingPing = res; write(req); })).then((r) => r && write(r));
    }
  });
  process.stdin.on('end', () => { log({ dir: 'eof' }); process.exit(0); });
  process.on('SIGTERM', () => { log({ dir: 'sigterm' }); process.exit(0); });
} else if (mode === 'http') {
  let wire = [];
  const SKIP = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding']);
  const hdrs = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !SKIP.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
  const sseStreams = new Map(); // variant → res
  let pendingPing = null;
  let session = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__log') { res.end(JSON.stringify(wire)); if (url.searchParams.get('reset')) wire = []; return; }
    const [, variant, kind] = url.pathname.split('/');
    const entry = { method: req.method, path: url.pathname + url.search, headers: hdrs(req.headers), body };
    wire.push(entry);
    const respond = (status, headers, text) => { entry.response = { status, headers, body: text }; res.writeHead(status, headers); res.end(text); };
    if (kind === 'mcp') {
      if (req.method === 'GET') {
        if (variant === 'legacy') return respond(405, { allow: 'POST, DELETE' }, '');
        return respond(405, {}, '');
      }
      if (req.method === 'DELETE') return respond(200, {}, '');
      if (variant === 'err404') return respond(404, { 'content-type': 'text/plain' }, 'no such endpoint');
      const msg = JSON.parse(body);
      if (!('method' in msg)) { if (msg.id === 'srv-ping-1' && pendingPing) { pendingPing(); pendingPing = null; } return respond(202, {}, ''); }
      if (!('id' in msg)) return respond(202, {}, '');
      const extra = {};
      if (variant === 'legacy' && msg.method === 'initialize') extra['mcp-session-id'] = `sess-${++session}`;
      if (variant === 'badct') return respond(200, { 'content-type': 'text/html' }, '<html/>');
      if (variant === 'sseresp' && msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
        const events = [];
        const sse = (o, id) => { const t = `${id ? `id: ${id}\n` : ''}event: message\ndata: ${JSON.stringify(o)}\n\n`; events.push(t); res.write(t); };
        const r = await handle(msg, variant, (sreq) => new Promise((ok) => { pendingPing = ok; sse(sreq, 'e1'); }));
        sse(r, 'e2');
        entry.response = { status: 200, headers: { 'content-type': 'text/event-stream' }, body: events.join('') };
        return res.end();
      }
      const r = await handle(msg, variant, () => Promise.resolve());
      if (msg.method === 'server/discover' && r.error) return respond(200, { 'content-type': 'application/json', ...extra }, JSON.stringify(r));
      return respond(200, { 'content-type': 'application/json', ...extra }, JSON.stringify(r));
    }
    if (kind === 'sse' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ep = `event: endpoint\ndata: /${variant}/messages?sid=1\n\n`;
      entry.response = { status: 200, stream: [ep] };
      res.write(ep);
      sseStreams.set(variant, { res, entry });
      req.on('close', () => sseStreams.delete(variant));
      return;
    }
    if (kind === 'messages' && req.method === 'POST') {
      respond(202, {}, 'Accepted');
      const s = sseStreams.get(variant);
      const msg = JSON.parse(body);
      if (!('method' in msg)) { if (msg.id === 'srv-ping-1' && pendingPing) { pendingPing(); pendingPing = null; } return; }
      const push = (o) => { const t = `event: message\ndata: ${JSON.stringify(o)}\n\n`; s?.entry.response.stream.push(t); s?.res.write(t); };
      const r = await handle(msg, variant, (sreq) => new Promise((ok) => { pendingPing = ok; push(sreq); }));
      if (r) push(r);
      return;
    }
    respond(404, {}, 'not found');
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else {
  console.error('usage: mcp-mock-server.mjs stdio|http');
  process.exit(2);
}
