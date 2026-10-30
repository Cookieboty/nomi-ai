// Parity cases for apps/desktop-electron/internal/gateway/src/trace.ts (batch 4d).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function recordTrace({ gw }) {
  const T = await gw('src/trace.ts');
  let seed = 23;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const word = (al, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += al[Math.floor(rnd() * al.length)];
    return s;
  };
  const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const frag = () =>
    pick([
      () =>
        pick(['Bearer ', 'bearer\u00a0', 'BEARER\t']) +
        word(B62 + '._~+/=-', 4 + Math.floor(rnd() * 12)),
      () => 'sk-' + word(B62 + '_-', 6 + Math.floor(rnd() * 20)),
      () => 'AIza' + word(B62 + '_-', 18 + Math.floor(rnd() * 20)),
      () =>
        pick(['xai', 'gsk', 'ghp', 'github_pat', 'hf']) +
        '_' +
        word(B62 + '_', 10 + Math.floor(rnd() * 10)),
      () =>
        pick(['?', '&']) +
        pick(['key', 'CODE', 'code_verifier', 'Token', 'client_secret', 'other']) +
        '=' +
        word(B62 + '-.%', 1 + Math.floor(rnd() * 20)),
      () => 'nomi-' + pick(['gw', 'tab']) + '-' + word(B62, 4 + Math.floor(rnd() * 8)),
      () =>
        pick(['user_code', 'Device-Code', 'usercode', 'device code']) +
        pick(['', '"', "'"]) +
        pick([':', '=', ' : ', '\u3000=']) +
        pick(['', '"']) +
        word('ABCDEFGHJK0123', 4) +
        '-' +
        word('ABCDEFGHJK0123', 3 + Math.floor(rnd() * 4)),
      () => 'postgres://u:' + word(B62, 8) + '@h/db',
      () => 'ghp_' + word(B62, 36),
      () => word('ab 中文😀\ud800\n\n{}":', 1 + Math.floor(rnd() * 8)),
      () => 'my-known-secret-' + pick(['A', 'B', 'AB']),
    ])();
  const text = () => {
    let s = '';
    for (let i = 0, n = Math.floor(rnd() * 6); i < n; i++) s += frag() + pick(['', ' ', '\n', ',']);
    return s;
  };
  const secretsSets = [
    [],
    ['my-known-secret-AB', 'my-known-secret-A', 'short', ''],
    ['😀😀😀', '\ud800abcde'],
  ];
  const redact = [];
  for (let i = 0; i < 600; i++) {
    const s = text();
    const k = i % secretsSets.length;
    redact.push([s, k, T.redactText(s, secretsSets[k])]);
  }

  const keys = [
    'authorization',
    'X-Api-Key',
    'api_key',
    'apiKey',
    'max_tokens',
    'token',
    'TOKEN',
    'ſecret',
    'secret',
    'tokens',
    'Code_Verifier',
    'auth_code',
    'authorization-code',
    'password',
    '__proto__',
    '1',
    '0',
    'messages',
  ];
  const val = (d) =>
    pick([
      () => text(),
      () => Math.floor(rnd() * 100),
      () => null,
      () => true,
      () => (d > 3 ? 'x' : obj(d + 1)),
      () => (d > 3 ? [] : [val(d + 1), text()]),
    ])();
  const obj = (d) => {
    const o = {};
    for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) {
      const k = pick(keys);
      if (k === '__proto__')
        Object.defineProperty(o, k, {
          value: val(d),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else o[k] = val(d);
    }
    return o;
  };
  const json = [];
  for (let i = 0; i < 200; i++) {
    const v = obj(0);
    const k = i % secretsSets.length;
    json.push([JSON.stringify(v), k, JSON.stringify(T.redactJson(v, secretsSets[k]))]);
  }
  // deep nesting (depth cut at 64)
  let deep = 'sk-' + 'a'.repeat(20);
  for (let i = 0; i < 70; i++) deep = [deep];
  json.push([JSON.stringify(deep), 0, JSON.stringify(T.redactJson(deep, []))]);

  const headers = [];
  for (let i = 0; i < 100; i++) {
    const h = {};
    for (let j = 0, n = Math.floor(rnd() * 5); j < n; j++)
      h[
        pick([
          'authorization',
          'cookie',
          'x-goog-api-key',
          'user-agent',
          'x-custom',
          'set-cookie',
          'referer',
        ])
      ] = rnd() < 0.3 ? [text(), text()] : text();
    headers.push([h, T.redactHeaders(h, secretsSets[1])]);
  }

  const diff = [];
  for (let i = 0; i < 200; i++) {
    const evs = Array.from(
      { length: Math.floor(rnd() * 6) },
      () => 'data: ' + pick(['a', 'b', 'c', ' d ', '']),
    );
    const sep = () => pick(['\n\n', '\r\n\r\n', '\n\r\n']);
    const up = evs.join(sep()) + (rnd() < 0.5 ? sep() : '');
    const cl =
      rnd() < 0.2
        ? up
        : evs
            .filter(() => rnd() < 0.7)
            .concat(rnd() < 0.5 ? ['data: z'] : [])
            .join(sep());
    diff.push([up, cl, T.traceDiff(up, cl)]);
  }
  const big = Array.from({ length: 250 }, (_, i) => `data: ${i}`).join('\n\n');
  diff.push([big, 'x', T.traceDiff(big, 'x')]);

  const stamps = [0, 1761034530123, -1, 253402300800000, -62198755200000, 8.64e15].map((t) => [
    t,
    T.traceStamp(t),
  ]);

  const cfg = {
    host: '127.0.0.1',
    port: 1,
    providers: [
      {
        id: 'p',
        keys: [
          { id: 'k', value: 'pkey-value-123456' },
          { id: 'k2', value: '' },
        ],
      },
    ],
    clients: {
      zed: { token: 'nomi-gw-zedtoken' },
      2: { token: 'tok-two-12345' },
      claude: { token: 'nomi-gw-claudetoken-long' },
    },
    legacyToken: 'legacy-token-xyz',
    privacy: {
      enabled: false,
      key: '',
      known: [
        { kind: 'CUSTOM', value: 'my-known-secret-AB' },
        { kind: 'CUSTOM', value: '' },
      ],
    },
  };
  const secretsOf = T.secretsOf(cfg);

  const files = [];
  for (let i = 0; i < 12; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'trace-'));
    const meta = {
      client: pick(['claude', 'é😀/x', 'a b']),
      ingress: 'messages',
      path: '/v1/messages?key=' + word(B62, 16),
      startedAt: 1761034530123 + i,
    };
    const tr = new T.RequestTrace(dir, cfg, meta, { id: 'abcdef' + i, now: () => 0 });
    const ops = [];
    if (rnd() < 0.5) {
      const v = ['added-secret-' + i, '', 'x'];
      tr.addSecrets(v);
      ops.push(['addSecrets', v]);
    }
    if (rnd() < 0.8) {
      const h = { authorization: 'Bearer abc', 'x-other': [text(), 'pkey-value-123456'] };
      const b = rnd() < 0.8 ? obj(0) : undefined;
      tr.request(h, b);
      ops.push(['request', h, b === undefined ? null : JSON.stringify(b), b !== undefined]);
    }
    for (let j = 0, n = Math.floor(rnd() * 3); j < n; j++) {
      const a = {
        provider: 'p',
        ...(rnd() < 0.5 ? { key: 'k' } : {}),
        wire: 'messages',
        url: 'https://x/v1?key=' + word(B62, 14),
        ...(rnd() < 0.5 ? { headers: { 'x-api-key': 'v', a: text() } } : {}),
        ...(rnd() < 0.7 ? { body: obj(0) } : {}),
      };
      tr.attempt(a);
      ops.push(['attempt', JSON.stringify(a)]);
      if (rnd() < 0.7) {
        const st = pick([200, 401, 500]);
        const er = pick([undefined, '', 'boom ' + text()]);
        tr.attemptResult(st, er);
        ops.push(['attemptResult', st, er ?? '']);
      }
    }
    for (let j = 0, n = Math.floor(rnd() * 4); j < n; j++) {
      const c = 'data: ' + text() + '\n\n';
      tr.response(200, c);
      ops.push(['response', 200, c]);
      if (rnd() < 0.7) {
        tr.client(c);
        ops.push(['client', c]);
      }
    }
    if (rnd() < 0.4) {
      tr.client('data: extra\n\n');
      ops.push(['client', 'data: extra\n\n']);
    }
    const result = {
      status: 200,
      ms: 12.5,
      attempts: 1,
      ...(rnd() < 0.5 ? { usage: { input: 1 } } : {}),
      ...(rnd() < 0.5 ? { error: pick(['', 'err sk-' + word(B62, 12)]) } : {}),
      ...(rnd() < 0.3 ? { notes: ['n1'] } : {}),
    };
    const file = await tr.finish(result);
    ops.push(['finish', JSON.stringify(result)]);
    const names = readdirSync(dir);
    files.push({
      meta,
      id: 'abcdef' + i,
      ops,
      name: file.slice(dir.length + 1),
      names,
      content: readFileSync(file, 'utf8'),
    });
    rmSync(dir, { recursive: true, force: true });
  }
  return { secretsSets, redact, json, headers, diff, stamps, cfg, secretsOf, files };
}
