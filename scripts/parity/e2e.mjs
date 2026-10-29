// End-to-end parity cases for packages/gateway/src/server.ts (batch 4d).
//
// Each case starts a fresh GatewayServer (createGateway) in front of a scripted
// mock upstream, sends one raw HTTP request and records what the client sees
// (status, selected headers, the whole body), every request the upstream
// received (method, path+query, selected headers, body) and every usage event.
// The Go replay (internal/gateway/parity_e2e_test.go) runs the same script
// against internal/mockllm's scripted server and the Go GatewayServer.
import http from 'node:http';

export const E2E_CLIENT_HEADERS = ['content-type', 'content-length', 'cache-control', 'retry-after',
  'x-nomi-served-model', 'x-nomi-redacted', 'x-accel-buffering', 'access-control-allow-origin'];
export const E2E_UPSTREAM_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'content-type',
  'accept', 'anthropic-version', 'anthropic-beta', 'user-agent', 'x-claude-code-session-id', 'accept-language', 'sec-fetch-mode'];

const WIRES = ['messages', 'responses', 'chat', 'gemini'];
const PROV = { messages: 'pm', responses: 'pr', chat: 'pc', gemini: 'pg' };
const TOK = { claude: 'tok-claude', codex: 'tok-codex', dsh: 'tok-dsh', gemini: 'tok-gemini' };
const INGRESS_CLIENT = { messages: 'claude', responses: 'codex', chat: 'dsh', gemini: 'gemini' };

function config(hostPort, patch = {}) {
  const base = `http://${hostPort}`;
  const providers = WIRES.map((w) => ({
    id: PROV[w], name: PROV[w].toUpperCase(), enabled: true,
    urls: { [w]: w === 'gemini' ? `${base}/gemini/v1beta` : `${base}/${w}/v1` },
    keys: [{ id: 'k1', value: `key-${PROV[w]}-1`, enabled: true }, { id: 'k2', value: `key-${PROV[w]}-2`, enabled: true }],
    models: [{ id: 'm1', enabled: true }],
  }));
  const clients = {};
  for (const [c, t] of Object.entries(TOK)) clients[c] = { token: t, models: { main: 'pc/m1' } };
  return { host: '127.0.0.1', port: 0, providers, clients, allowedPrivateHosts: [hostPort], ...patch };
}

function clientReq(ingress, model, stream, extra = {}) {
  const client = INGRESS_CLIENT[ingress];
  const auth = ingress === 'messages' ? { 'x-api-key': TOK[client] }
    : ingress === 'gemini' ? { 'x-goog-api-key': TOK[client] } : { authorization: `Bearer ${TOK[client]}` };
  const headers = { 'content-type': 'application/json', 'user-agent': 'e2e/1', 'accept-encoding': 'identity', ...auth };
  const text = extra.text ?? 'hi there';
  let path, body;
  if (ingress === 'messages') { path = '/v1/messages'; body = { model, max_tokens: 64, ...(stream ? { stream: true } : {}), messages: [{ role: 'user', content: text }] }; }
  else if (ingress === 'responses') { path = '/v1/responses'; body = { model, ...(stream ? { stream: true } : {}), input: text }; }
  else if (ingress === 'chat') { path = '/v1/chat/completions'; body = { model, ...(stream ? { stream: true } : {}), messages: [{ role: 'user', content: text }] }; }
  else { path = `/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`; body = { contents: [{ role: 'user', parts: [{ text }] }] }; }
  return { method: 'POST', path, headers, body: JSON.stringify(body) };
}

export function e2eCases({ upstreamSse, upstreamJson }) {
  const ok = (w) => ({ ok: w, sse: upstreamSse[w][0], json: JSON.stringify(upstreamJson[w][0]) });
  const err = (status, msg, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ error: { message: msg } }) });
  const out = [];
  for (const ing of WIRES) for (const up of WIRES) for (const stream of [true, false]) {
    out.push({ name: `${ing}->${up}${stream ? ' stream' : ''}`, req: clientReq(ing, `${PROV[up]}/m1`, stream), script: [ok(up)] });
  }
  const chat = (s, x) => clientReq('chat', 'pc/m1', s, x);
  out.push(
    { name: 'retry 429 next key', req: chat(true), script: [err(429, 'slow down', { 'retry-after': '7' }), ok('chat')] },
    { name: 'all 500', req: chat(true), script: [err(500, 'boom')] },
    { name: 'all 500 json', req: chat(false), script: [err(500, 'boom')] },
    { name: 'auth 401', req: chat(false), script: [err(401, 'bad key')] },
    { name: 'bad request 400', req: chat(true), script: [err(400, 'invalid thing')] },
    { name: 'not found 404', req: chat(true), script: [err(404, 'no such model')] },
    { name: 'html 502', req: chat(false), script: [{ status: 502, headers: { 'content-type': 'text/html' }, body: '<html>bad gateway</html>' }] },
    { name: 'non json 200', req: chat(false), script: [{ status: 200, headers: { 'content-type': 'application/json' }, body: 'not json' }] },
    { name: 'sse error event', req: chat(true), script: [{ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"error":{"message":"overloaded","type":"overloaded_error"}}\n\n' }] },
    { name: 'empty sse', req: chat(true), script: [{ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' }] },
    { name: 'messages err 429', req: clientReq('messages', 'pm/m1', true), script: [err(429, 'rate')] },
    { name: 'responses err 500', req: clientReq('responses', 'pr/m1', false), script: [err(500, 'x')] },
    { name: 'gemini err 403', req: clientReq('gemini', 'pg/m1', true), script: [err(403, 'denied')] },
    { name: 'main model', req: chat(true), script: [ok('chat')], patchReq: { model: 'whatever' } },
    { name: 'unknown provider', req: chat(false), script: [ok('chat')], patchReq: { model: 'zz/m9' } },
    { name: 'invalid json body', req: { ...chat(false), body: '{nope' }, script: [ok('chat')] },
    { name: 'empty body', req: { ...chat(false), body: '' }, script: [ok('chat')] },
    { name: 'too large', req: chat(false, { text: 'x'.repeat(5000) }), cfg: { maxRequestBodyBytes: 1024 }, script: [ok('chat')] },
    { name: 'bad token', req: { ...chat(false), headers: { ...chat(false).headers, authorization: 'Bearer nope' } }, script: [ok('chat')] },
    { name: 'no token', req: { ...chat(false), headers: { 'content-type': 'application/json', 'user-agent': 'e2e/1', 'accept-encoding': 'identity' } }, script: [ok('chat')] },
    { name: 'origin', req: { ...chat(false), headers: { ...chat(false).headers, origin: 'https://evil.example' } }, script: [ok('chat')] },
    { name: 'unknown path', req: { ...chat(false), path: '/v1/nothing' }, script: [ok('chat')] },
    { name: 'health', req: { method: 'GET', path: '/health', headers: { 'user-agent': 'e2e/1' }, body: '' }, script: [] },
    { name: 'models', req: { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer tok-dsh', 'user-agent': 'e2e/1' }, body: '' }, script: [] },
    { name: 'count tokens', req: { ...clientReq('messages', 'pm/m1', false), path: '/v1/messages/count_tokens' }, script: [{ status: 200, headers: { 'content-type': 'application/json' }, body: '{"input_tokens":11}' }] },
    { name: 'count tokens fallback', req: { ...clientReq('messages', 'pc/m1', false), path: '/v1/messages/count_tokens' }, script: [] },
    { name: 'privacy mask', req: chat(false, { text: 'my key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789 ok' }), cfg: { privacy: { enabled: true, key: 'e2e-privacy-key' } }, script: [ok('chat')] },
    { name: 'privacy mask stream', req: chat(true, { text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here' }), cfg: { privacy: { enabled: true, key: 'e2e-privacy-key' } }, script: [ok('chat')] },
  );
  for (const c of out) if (c.patchReq) { const b = JSON.parse(c.req.body); Object.assign(b, c.patchReq); c.req = { ...c.req, body: JSON.stringify(b) }; delete c.patchReq; }
  return out;
}

/** The scripted upstream; mirrored by mockllm.StartScripted. */
function startUpstream() {
  let script = [], seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = {};
      for (const h of E2E_UPSTREAM_HEADERS) if (req.headers[h] !== undefined) headers[h] = String(req.headers[h]);
      seen.push({ method: req.method, url: req.url, headers, body });
      const step = script.length ? script[Math.min(seen.length - 1, script.length - 1)] : { status: 599, headers: {}, body: 'unscripted' };
      if (step.ok) {
        let stream = req.url.includes('streamGenerateContent');
        try { stream ||= JSON.parse(body).stream === true; } catch { /* */ }
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
        res.end(stream ? step.sse : step.json);
        return;
      }
      res.writeHead(step.status, step.headers);
      res.end(step.body);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    hostPort: `127.0.0.1:${srv.address().port}`,
    set: (s) => { script = s; seen = []; },
    seen: () => seen,
    close: () => new Promise((d) => { srv.closeAllConnections?.(); srv.close(() => d()); }),
  })));
}

function send(url, r) {
  return new Promise((resolve, reject) => {
    const u = new URL(r.path, url);
    const q = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: r.method, headers: { ...r.headers, ...(r.body ? { 'content-length': Buffer.byteLength(r.body) } : {}) } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const headers = {};
        for (const h of E2E_CLIENT_HEADERS) if (res.headers[h] !== undefined) headers[h] = String(res.headers[h]);
        resolve({ status: res.statusCode, headers, body: Buffer.concat(parts).toString('utf8') });
      });
      res.on('error', reject);
    });
    q.on('error', reject);
    if (r.body) q.write(r.body);
    q.end();
  });
}

export async function recordE2E({ gw }) {
  const S = await gw('src/server.ts');
  const fx = await gw('tests/fixtures/cases.ts');
  await import(new URL('../../packages/gateway/tests/setup/clients.ts', import.meta.url).href);
  const up = await startUpstream();
  const cases = e2eCases(fx);
  const out = [];
  for (const c of cases) {
    up.set(c.script);
    const cfg = config(up.hostPort, c.cfg);
    const usage = [];
    const g = S.createGateway(cfg, { onUsage: (e) => usage.push(e), logger: { info() {}, warn() {} } });
    await g.start();
    const res = await send(g.listenUrl(), c.req);
    await new Promise((r) => setTimeout(r, 30));
    await g.stop();
    out.push({ name: c.name, cfg: c.cfg ?? null, req: c.req, script: c.script, res, upstream: up.seen(), usage });
  }
  await up.close();
  return { clientHeaders: E2E_CLIENT_HEADERS, upstreamHeaders: E2E_UPSTREAM_HEADERS, cases: out };
}
