#!/usr/bin/env node
/**
 * gatewayRequests.ts / quality/legacy.ts / GatewayRequestLog.ts parity 录制（真实源码 esbuild 去类型；
 * @nomi-ai/gateway 指向 apps/desktop-electron/internal/gateway/src/trace.ts 源码，需 tsx）。结果 JSON.stringify 逐字节比较。
 * Go 回放：internal/core/usage/gwreq_parity_test.go。
 * Usage: node --import tsx scripts/parity/record-usage-gwreq.mjs
 */
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { jsModule, loadSrc, root } from './usage-src.mjs';

const traceUrl = pathToFileURL(
  join(root, 'apps/desktop-electron/internal/gateway/src/trace.ts'),
).href;
const gw = jsModule(`export { redactText, pruneTraces } from "${traceUrl}";`);
const gr = await loadSrc('usage/gatewayRequests', { '@nomi-ai/gateway': gw });
const names = await loadSrc('usage/quality/modelNames', {});
const agg = await loadSrc('usage/quality/aggregate', { './modelNames': names.url });
const fg = await loadSrc('usage/quality/fromGateway', {
  '../gatewayRequests': gr.url,
  './aggregate': agg.url,
});
const legacy = await loadSrc('usage/quality/legacy', {
  './aggregate': agg.url,
  './fromGateway': fg.url,
});
const grl = await loadSrc('usage/GatewayRequestLog', {
  '@nomi-ai/gateway': gw,
  './gatewayRequests': gr.url,
  './quality/legacy': legacy.url,
});
const { toEntry, sanitizeEntries, cleanError } = gr.mod;
const { recordFromEntry } = legacy.mod;
const { GatewayRequestLog, readLegacyGatewayTrace } = grl.mod;

const long = 'é'.repeat(150) + '😀'.repeat(100);
const E = (o = {}) => ({
  client: 'claude',
  ingress: 'messages',
  status: 200,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5 },
  startedAt: 1_780_000_000_000,
  ms: 1234.5,
  attempts: 1,
  ...o,
});
const toEntryCases = [
  [E(), 'r1', undefined],
  [E({ wire: 'messages' }), 'r2', {}],
  [
    E({ wire: 'chat', provider: 'deepseek', keyId: 'k1', model: 'ds/v3' }),
    'r3',
    { provider: 'DeepSeek', key: 'main key' },
  ],
  [
    E({
      usage: { inputTokens: 10, cacheReadTokens: 30, reasoningTokens: 7 },
      status: 502.9,
      ms: -3,
      attempts: 0,
      firstByteMs: 0.5,
    }),
    'r4',
    { provider: '' },
  ],
  [
    E({ usage: null, client: '', ingress: 5, startedAt: -1, attempts: 3.7, firstByteMs: -1 }),
    'r5',
    undefined,
  ],
  [
    E({
      client: 'x'.repeat(40),
      ingress: long,
      wire: long,
      provider: long,
      model: long,
      keyId: long,
    }),
    'r6',
    { provider: long, key: long },
  ],
  [
    E({
      notes: [
        'a',
        '',
        5,
        null,
        ' b ',
        'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
        'c',
        'd',
        'e',
        'f',
        'g',
        'h',
        'i',
        long,
      ],
    }),
    'r7',
    undefined,
  ],
  [E({ notes: 'x', error: 'boom\n\t  with   spaces\u00a0and\u2028more  ' }), 'r8', undefined],
  [E({ error: '' }), 'r9', undefined],
  [
    E({ error: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 ' + 'y'.repeat(400) }),
    'r10',
    undefined,
  ],
  [E({ error: '😀'.repeat(160) }), 'r10b', undefined],
  [
    E({ traceId: 'abc_DEF-123', tabId: 'tab:1.2-x', generation: 3, resolved: 'tier' }),
    'r11',
    undefined,
  ],
  [
    E({ traceId: 'bad id', tabId: 'x'.repeat(81), generation: 2.5, resolved: 'TIER' }),
    'r12',
    undefined,
  ],
  [E({ traceId: 'x'.repeat(65), tabId: '', generation: 0, resolved: 'default' }), 'r13', undefined],
  [
    E({ traceId: 'x'.repeat(64), tabId: 'x'.repeat(80), generation: -1, resolved: 'subagent' }),
    'r14',
    undefined,
  ],
  [
    E({
      usage: { inputTokens: '100', outputTokens: true, cacheWriteTokens: -5 },
      status: '200',
      ms: '5',
    }),
    'r15',
    undefined,
  ],
  [E({ firstByteMs: 2.5, ms: 2.5 }), 'r16', undefined],
  [E({ notes: ['n'.repeat(130), 'b'] }), 'r18', undefined],
  [E({ firstByteMs: '3' }), 'r17', undefined],
];
const entries = toEntryCases.map(([e, id, n]) => JSON.stringify(toEntry(e, id, n)));

const good = (o = {}) => ({
  id: 'g',
  ts: 1_780_000_000_000,
  client: 'codex',
  ingress: 'responses',
  wire: 'responses',
  providerId: 'openai',
  provider: 'OpenAI',
  keyId: 'k',
  key: 'K',
  model: 'gpt-5-2025-08-07',
  status: 200,
  ms: 900,
  firstByteMs: 120,
  attempts: 2,
  input: 50,
  output: 10,
  cacheRead: 40,
  cacheWrite: 0,
  reasoning: 4,
  notes: [' n1 ', ''],
  traceId: 't1',
  tabId: 'tb',
  generation: 2,
  resolved: 'binding',
  ...o,
});
const sanitizeCases = [
  null,
  {},
  'x',
  [],
  [null, 5, 'a', [1], { id: 1, ts: 1 }, { id: 'x', ts: '1' }, { id: 'x' }],
  [
    good(),
    good({ id: 'h', wire: 'messages', input: 50 }),
    good({
      id: 'i',
      client: null,
      ingress: undefined,
      status: '404',
      ms: 'x',
      attempts: [3],
      input: '5',
      output: [7],
      cacheRead: {},
      reasoning: null,
    }),
  ],
  [
    good({
      client: 5,
      ingress: true,
      status: true,
      error: 'first byte timeout',
      providerId: undefined,
      provider: 7,
      key: null,
      generation: '3',
      resolved: 5,
      notes: 'zz',
    }),
  ],
  [
    good({
      client: { a: 1 },
      ingress: [1, [2, 3], null],
      ms: [],
      attempts: '',
      model: 'Anthropic/Claude-Sonnet-4-5@20250929',
      status: 499,
    }),
  ],
  Array.from({ length: 205 }, (_, i) => good({ id: `n${i}`, ts: i })),
];
const sanitized = sanitizeCases.map((c) => JSON.stringify(sanitizeEntries(c)));

const errs = [
  undefined,
  '',
  '  ',
  'a\r\nb',
  'x'.repeat(300),
  'x'.repeat(301),
  '😀'.repeat(151),
  'token=sk-proj-abcdefghijklmnopqrstuvwx1234 end',
  '\ufeff hi \ufeff',
];
const cleaned = errs.map((e) => cleanError(e) ?? '__undef__');

// legacy：各种 status / error 组合覆盖 deriveOutcome / modelFamily / cleanNotes
const L = (o) => good({ notes: undefined, ...o });
const legacyIn = [
  L({}),
  L({ status: 200, error: 'x' }),
  L({ status: 0 }),
  L({ status: 0, providerId: undefined }),
  L({ status: 499 }),
  L({ status: 401 }),
  L({ status: 403 }),
  L({ status: 429 }),
  L({ status: 504 }),
  L({ status: 500, error: '首字超时' }),
  L({ status: 500, error: 'FIRST-BYTE wait' }),
  L({ status: 500, error: 'firstbyte' }),
  L({ status: 500, error: 'first\nbyte' }),
  L({ status: 500, error: 'first😀byte' }),
  L({ status: 500, error: 'firſt byte' }),
  L({ status: 500, error: '没有响应' }),
  L({ status: 500, error: 'IDLE' }),
  L({ status: 500, error: '没有任何输出' }),
  L({ status: 500, error: '上游中断' }),
  L({ status: 500, error: '结束标记缺失' }),
  L({ status: 500, error: '断开' }),
  L({ status: 500, error: 'Repetition' }),
  L({ status: 500, error: '复读' }),
  L({ status: 400 }),
  L({ status: 404 }),
  L({ status: 413 }),
  L({ status: 422 }),
  L({ status: 418 }),
  L({ status: 418, providerId: undefined }),
  L({ status: 503, providerId: undefined }),
  L({ status: 200, error: 'pre' }),
  L({ status: 302, error: 'redirect' }),
  L({ status: 500, error: 'e'.repeat(200) }),
  L({ model: '  OpenRouter/Anthropic/Claude-3-5-Sonnet-latest ' }),
  L({ model: 'gemini-2.5-pro@20250101' }),
  L({ model: 'qwen3:32b-q4' }),
  L({ model: 'deepseek-chat-20250101' }),
  L({ model: '/' }),
  L({ model: 'x-latest:tag' }),
  L({ wire: undefined }),
  L({ ingress: 'chat', wire: 'messages' }),
  L({
    client: 'nomi',
    firstByteMs: undefined,
    input: 0,
    output: 0,
    cacheRead: 0,
    reasoning: 0,
    cacheWrite: 3,
  }),
  L({ notes: ['  a ', '', '   ', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'x'.repeat(130)] }),
  L({ notes: ['   '] }),
  L({ notes: ['y'.repeat(130), '1', '2', '3', '4', '5', '6', '7', '8', '9'] }),
  L({ generation: 0, traceId: '', tabId: '', resolved: 'nope', keyId: '' }),
];
const legacyOut = legacyIn.map((x) => JSON.stringify(sanitizeEntries([x]).map(recordFromEntry)));

// GatewayRequestLog 场景
const NOW = 1_780_000_000_000;
const scen = [];
const logger = (w) => ({ info() {}, warn: (m) => w.push(m) });
const run = (name, files, opts) => {
  const dir = mkdtempSync(join(tmpdir(), 'grl-'));
  const traceFiles = [];
  for (const [rel, body, ageMs] of files) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    if (body === '__dir__') mkdirSync(p, { recursive: true });
    else writeFileSync(p, body);
    if (ageMs !== undefined) {
      const t = (NOW - ageMs) / 1000;
      utimesSync(p, t, t);
      traceFiles.push(rel);
    }
  }
  const warns = [],
    imported = [];
  let traceOn = !!opts.traceOn;
  const l = new GatewayRequestLog({
    root: dir,
    logger: logger(warns),
    traceOn: () => traceOn,
    now: () => NOW,
    pruneMs: 0,
    importLegacy: opts.noImport
      ? undefined
      : (recs) => {
          if (opts.importThrows) throw new Error('nope');
          imported.push(...recs);
        },
  });
  const res = {
    name,
    files,
    opts,
    imported: JSON.stringify(imported),
    warns: warns.length,
    requestsLeft: existsSync(join(dir, 'requests.json')),
    traceDir:
      l.traceDir() === undefined ? null : l.traceDir().slice(dir.length).replace(/\\/g, '/'),
    remaining: existsSync(join(dir, 'trace')) ? readdirSync(join(dir, 'trace')).sort() : null,
    legacyTrace: readLegacyGatewayTrace(dir),
  };
  traceOn = !traceOn;
  res.traceDir2 =
    l.traceDir() === undefined ? null : l.traceDir().slice(dir.length).replace(/\\/g, '/');
  res.prune2 = l.prune();
  l.dispose();
  rmSync(dir, { recursive: true, force: true });
  scen.push(res);
};
const reqs = JSON.stringify({
  requests: [good(), good({ id: 'b', status: 500, error: 'idle 30s' })],
});
run(
  'migrate',
  [
    ['requests.json', reqs],
    ['observe.json', '{"trace":true}'],
  ],
  {},
);
run(
  'migrate-throws',
  [
    ['requests.json', reqs],
    ['observe.json', '{"trace":"true"}'],
  ],
  { importThrows: true },
);
run('migrate-noimport', [['requests.json', reqs]], { noImport: true, traceOn: true });
run(
  'migrate-empty',
  [
    ['requests.json', '{"requests":[{"id":1}]}'],
    ['observe.json', '[true]'],
  ],
  { importThrows: true },
);
run(
  'migrate-bad-json',
  [
    ['requests.json', '{bad'],
    ['observe.json', 'nope'],
  ],
  {},
);
run(
  'migrate-null',
  [
    ['requests.json', 'null'],
    ['observe.json', 'null'],
  ],
  {},
);
run('migrate-dir', [['requests.json', '__dir__']], {});
run('migrate-bom', [['requests.json', '\ufeff' + reqs]], {});
run(
  'prune',
  [
    ['trace/old.json', '{}', 25 * 3600e3],
    ['trace/new.json', '{}', 3600e3],
    ['trace/old.tmp', '', 48 * 3600e3],
    ['trace/old.txt', '', 48 * 3600e3],
    ['trace/edge.json', '', 24 * 3600e3 + 1000],
  ],
  { traceOn: true },
);

const out = join(root, 'apps/desktop-go/internal/core/usage/testdata/usage-gwreq.json');
writeFileSync(
  out,
  JSON.stringify(
    {
      toEntryCases: toEntryCases.map(([e, id, n]) => [
        JSON.stringify(e),
        id,
        n === undefined ? '__undef__' : JSON.stringify(n),
      ]),
      entries,
      sanitizeCases: sanitizeCases.map((c) => JSON.stringify(c) ?? '__undef__'),
      sanitized,
      errs: errs.map((e) => e ?? '__undef__'),
      cleaned,
      legacyIn: legacyIn.map((x) => JSON.stringify(x)),
      legacyOut,
      now: NOW,
      scen,
    },
    null,
    1,
  ) + '\n',
);
console.log(
  `usage-gwreq: ${entries.length} toEntry, ${sanitized.length} sanitize, ${cleaned.length} cleanError, ${legacyOut.length} legacy, ${scen.length} log scenarios`,
);
