#!/usr/bin/env node
/**
 * AI runtime provider-management parity recorder (batch 4d item 3,
 * docs/design/migrate-2.0.5-go.md). Loads apps/desktop-electron/internal/ai-runtime/src/providers through
 * tsx and records:
 *   presets_gen.json – PROVIDER_PRESETS verbatim (embedded by internal/ai/providers)
 *   providers.json.gz – protocol helpers, maskSecret, presets search, env shims,
 *                       migrateStoreData and scripted ProviderService/ProviderStore runs
 * Generated ids (`p-<preset>-xxxxxxxx`, `k-xxxxxxxx`) are masked in order of first
 * appearance on both sides; everything else must match byte for byte.
 *
 * Usage: TZ=Asia/Shanghai node scripts/parity/airuntime.mjs
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { register } from 'tsx/esm/api';

register();

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgDir = join(root, 'apps/desktop-go/internal/ai/providers');
const outDir = join(pkgDir, 'testdata/parity');
const rt = (p) =>
  import(pathToFileURL(join(root, 'apps/desktop-electron/internal/ai-runtime/src', p)).href);

const presets = await rt('providers/presets.ts');
const protocol = await rt('providers/protocol.ts');
const cipherMod = await rt('providers/secretCipher.ts');
const storeMod = await rt('providers/ProviderStore.ts');
const svcMod = await rt('providers/ProviderService.ts');
const ig = await rt('igPlugins.ts');

writeFileSync(
  join(pkgDir, 'presets_gen.json'),
  JSON.stringify(presets.PROVIDER_PRESETS, null, 2) + '\n',
);
console.log('wrote presets_gen.json');

const err = (fn) => {
  try {
    return { ok: true, v: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

// ---------------------------------------------------------------- protocol
const bases = [
  'https://api.openai.com/v1',
  'https://api.openai.com/v1/',
  '  https://api.anthropic.com  ',
  'https://api.anthropic.com/V1',
  'https://x.example/v1/chat/completions',
  'https://x.example/v1/Chat/Completions?key=1',
  'https://x.example/v1/responses',
  'https://x.example/v1/messages',
  'https://x.example:443/custom/endpoint',
  'http://LOCALHOST:8080/a/b',
  'not a url',
  'ftp://x/y',
  'https://x.example/v1///',
];
const proto = [];
for (const p of protocol.PROTOCOLS)
  for (const b of bases)
    for (const f of [false, true])
      proto.push({
        protocol: p,
        base: b,
        fullUrl: f,
        sdk: protocol.sdkBaseURL(p, b, f),
        endpoint: protocol.endpointURL(p, b, f),
        models: protocol.modelsURL(p, b, f),
      });
const headers = [];
for (const p of protocol.PROTOCOLS)
  for (const k of [undefined, 'sk-1'])
    for (const extra of [undefined, { 'User-Agent': 'ua', accept: 'x' }])
      headers.push({
        protocol: p,
        key: k ?? null,
        extra: extra ?? null,
        out: protocol.modelsRequestHeaders(p, k, extra),
      });
const lists = [
  { object: 'list', data: [{ id: 'gpt-b', owned_by: 'openai' }, { id: 'gpt-a' }, { id: 'gpt-a' }] },
  { data: [{ id: 'claude-x', display_name: 'Claude X', type: 'model' }], has_more: false },
  { models: [{ name: 'llama3' }, { model: 'qwen' }, { name: '  ' }, {}] },
  ['b', 'a', 'B', 'ä', '_z', '10', '9'],
  null,
  { data: 'x' },
  [{ id: '', model: 'm1' }, 5, null],
];
const parsed = lists.map((l) => ({ in: l, out: err(() => protocol.parseModelList(l)) }));
const maps = [
  ['a', undefined],
  ['a', []],
  ['a', [{ from: 'a', to: ' b ' }]],
  [
    'c',
    [
      { from: '*', to: 'z' },
      { from: 'c', to: 'y' },
    ],
  ],
  [
    'c',
    [
      { from: 'c', to: '  ' },
      { from: '*', to: 'z' },
    ],
  ],
].map(([m, mp]) => ({ model: m, map: mp ?? null, out: protocol.mapModel(m, mp) }));

// ---------------------------------------------------------------- secrets / presets / env
const masks = [
  '',
  ' a ',
  'ab',
  'abcdefgh',
  'abcdefghi',
  'sk-abcdefghijklmnop',
  '😀😀😀😀😀',
  'sk-😀abcdef😀',
].map((s) => ({ in: s, out: cipherMod.maskSecret(s) }));
const searches = ['', '  ', 'OPENAI', 'deepseek', 'api', '中', 'gpt', 'zzz', 'https://'].map(
  (q) => ({
    q,
    ids: presets.searchPresets(q).map((p) => p.id),
  }),
);
const envs = [
  {},
  { OPENAI_API_KEY: ' sk-o ', DEEPSEEK_MODEL: 'dm', OLLAMA_BASE_URL: 'http://o' },
  {
    CLAUDE_API_KEY: 'c',
    ANTHROPIC_API_KEY: '  ',
    GEMINI_API_KEY: 'g',
    GEMINI_MODEL: ' gm ',
    NOMI_PROVIDER: ' claude ',
  },
  {
    DEEPSEEK_API_KEY: 'd',
    GOOGLE_GENERATIVE_AI_API_KEY: 'gg',
    GOOGLE_GENERATIVE_AI_BASE_URL: 'http://g',
    NOMI_PROVIDER: '',
  },
].map((env) => ({
  env,
  entries: ig.llmProvidersFromEnv(env),
  override: ig.providerOverrideFromEnv(env) ?? null,
}));

// ---------------------------------------------------------------- migrate
const raws = [
  {},
  {
    version: 2,
    providers: [],
    routes: { summary: { providerId: 'x' } },
    usage: { x: { requests: 1 } },
    activeProviderId: 'x',
  },
  {
    providers: [
      {
        id: 'a',
        name: 'A',
        backend: 'google',
        baseURL: 'https://g/v1beta/',
        defaultModel: ' gm ',
        keys: [{ id: 'k1' }],
      },
      {
        id: 'b',
        backend: 'anthropic',
        presetId: 'claude',
        models: ['m2', 'm2', ' m3 '],
        defaultModel: 'm1',
        enabled: false,
      },
      {
        id: 'c',
        protocol: 'openai-responses',
        backend: 'google',
        baseURL: 'https://g/openai',
        presetId: 'moonshot',
        fullUrl: 1,
      },
      { id: 'd', baseURL: 'https://g/openai/', websiteUrl: 'https://w', backend: 'google' },
    ],
    routes: { chat: { providerId: 'b', model: 'mx' }, summary: { providerId: 'a' } },
    usage: [],
  },
  {
    version: '1',
    routes: { chat: { providerId: 'zz' } },
    activeProviderId: 'y',
    providers: 'nope',
  },
  { version: 3, routes: 'r', usage: 5 },
];
const migrate = raws.map((raw) => ({ raw, out: storeMod.migrateStoreData(structuredClone(raw)) }));

// ---------------------------------------------------------------- scripted service runs
function resolveRefs(v, store) {
  if (typeof v === 'string' && v.startsWith('$p')) {
    const [pi, ki] = v.slice(2).split('.k');
    const p = store.providers()[Number(pi)];
    if (ki === undefined) return p?.id ?? `missing-${pi}`;
    return p?.keys[Number(ki)]?.id ?? `missing-${v}`;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, store));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, store)]));
  return v;
}

function runScript(sc) {
  const dir = mkdtempSync(join(tmpdir(), 'nomi-prov-'));
  const file = sc.file ? join(dir, 'ai-providers.json') : undefined;
  if (file && sc.initial !== undefined) writeFileSync(file, sc.initial);
  let t = 1_700_000_000_000;
  const calls = [];
  const store = new storeMod.ProviderStore({
    filePath: file,
    cipher: cipherMod.plaintextCipher,
    now: () => (t += 1000),
    usageFlushMs: 60_000,
    onCall: (e) => calls.push(e),
  });
  let changes = 0;
  store.onChange(() => changes++);
  const entries = ig.llmProvidersFromEnv(sc.env ?? {});
  const svc = new svcMod.ProviderService({
    store,
    envEntries: entries,
    getRegistry: () => undefined,
    overrideId: ig.providerOverrideFromEnv(sc.env ?? {}),
  });
  const files = () =>
    readdirSync(dir)
      .sort()
      .map((n) => ({ name: n.replace(/\d{13}/, 'TS'), text: readFileSync(join(dir, n), 'utf8') }));
  const steps = [];
  steps.push({ op: 'init', files: files(), state: svc.state() });
  for (const [op, ...args0] of sc.ops) {
    const args = resolveRefs(args0, store);
    const before = changes;
    const r = err(() => {
      switch (op) {
        case 'upsert':
          return svc.upsert(args[0]);
        case 'remove':
          return svc.remove(args[0]);
        case 'setActive':
          return svc.setActive(args[0], args[1]);
        case 'setModels':
          return svc.setModels(args[0], args[1]);
        case 'storeSetModels':
          return store.setModels(args[0], args[1]);
        case 'setRoute':
          return svc.setRoute(args[0], args[1]);
        case 'addKey':
          return svc.addKey(args[0], args[1], args[2]);
        case 'rotateKey':
          return svc.rotateKey(args[0], args[1], args[2]);
        case 'removeKey':
          return svc.removeKey(args[0], args[1]);
        case 'promoteKey':
          return svc.promoteKey(args[0], args[1]);
        case 'resetUsage':
          return svc.resetUsage(args[0]);
        case 'markKey':
          return store.markKey(args[0], args[1], args[2]);
        case 'recordUsage':
          return store.recordUsage(args[0], args[1], args[2]);
        case 'recordCall':
          return store.recordCall(args[0]);
        case 'resolveKeys':
          return store.resolveKeys(args[0]);
        case 'usage':
          return store.usage();
        case 'routes':
          return store.routes();
        case 'has':
          return store.has(args[0]);
        case 'flush':
          return store.flush();
        case 'state':
          return svc.state();
        case 'meta':
          return svc.meta();
        case 'presets':
          return svc.presets().map((p) => p.id);
        case 'reload':
          return new storeMod.ProviderStore({
            filePath: file,
            cipher: cipherMod.plaintextCipher,
            now: () => (t += 1000),
          }).list();
        default:
          throw new Error(`bad op ${op}`);
      }
    });
    steps.push({
      op,
      args,
      ...r,
      v: r.v === undefined ? null : r.v,
      changed: changes - before,
      files: files(),
      state: svc.state(),
    });
  }
  steps.push({ op: 'calls', v: calls });
  rmSync(dir, { recursive: true, force: true });
  return steps;
}

const scripts = [
  {
    name: 'crud',
    file: true,
    env: { OPENAI_API_KEY: 'sk-envopenai', NOMI_PROVIDER: 'openai' },
    ops: [
      ['meta'],
      ['presets'],
      ['upsert', { presetId: 'deepseek', apiKey: ' sk-deepseek-1234567890 ' }],
      ['upsert', { presetId: 'nope', name: '  ', baseURL: 'https://my.example/v1/' }],
      ['upsert', { presetId: 'custom' }],
      ['upsert', { presetId: 'custom', baseURL: 'ftp://x' }],
      ['upsert', { presetId: 'openai', apiKey: 'has space' }],
      [
        'upsert',
        {
          presetId: 'anthropic',
          defaultModel: ' cm ',
          models: ['a', ' a ', '', 'b'],
          note: ' n ',
          headers: { 'X-A': '1', 'X-B': 2 },
          userAgent: ' ua ',
          thinking: true,
          modelMap: [
            { from: 'x', to: 'y' },
            { from: '', to: 'z' },
          ],
          enabled: false,
        },
      ],
      ['upsert', { presetId: 'custom', baseURL: 'https://h', headers: { 'bad name': 'x' } }],
      ['upsert', { id: '$p0', name: ' renamed ', note: '', websiteUrl: 'ftp://w' }],
      [
        'upsert',
        {
          id: '$p0',
          websiteUrl: ' https://w ',
          protocol: 'anthropic',
          fullUrl: 1,
          defaultModel: '',
          models: ['x'],
          thinking: false,
          headers: {},
          userAgent: '',
          apiKey: 'sk-second-key-000000',
          enabled: 0,
        },
      ],
      ['upsert', { id: '$p0', protocol: 'grpc' }],
      ['upsert', { id: '$p0', modelMap: 'x' }],
      ['setModels', '$p0', ['m1', ' m1', 'm2']],
      ['storeSetModels', '$p1', { fetched: [{ id: 'f1', name: 'F' }], enabled: [] }],
      ['setModels', 'missing', []],
      ['addKey', '$p1', 'sk-third-abcdefghijkl', ' lbl '],
      ['addKey', '$p1', '   '],
      ['addKey', '$p1', 'a b'],
      ['rotateKey', '$p1', '$p1.k0', 'sk-rotated-zzzzzzzzzz'],
      ['rotateKey', '$p1', 'k-nope', 'x'],
      ['promoteKey', '$p0', '$p0.k1'],
      ['promoteKey', '$p0', 'k-nope'],
      ['removeKey', '$p0', '$p0.k0'],
      ['removeKey', '$p0', 'k-nope'],
      ['resolveKeys', '$p0'],
      ['resolveKeys', '$p1'],
      ['setActive', '$p2', ' am '],
      ['setActive', '$p0', null],
      ['setActive', 'openai', undefined],
      ['setActive', 'ghost'],
      ['setActive', null],
      ['setRoute', 'summary', { providerId: '$p1', model: '  ' }],
      ['setRoute', 'agent-tools', { providerId: 'openai', model: ' m ' }],
      ['setRoute', 'chat', { providerId: '$p0' }],
      ['setRoute', 'summary', { providerId: 'ghost' }],
      ['setRoute', 'bogus', { providerId: '$p0' }],
      ['setRoute', 'agent-tools', null],
      ['setActive', '$p0', 'm9'],
      ['routes'],
      ['markKey', '$p0', 0, 'x'.repeat(250)],
      ['markKey', '$p0', 9],
      ['recordUsage', '$p0', { inputTokens: 3, outputTokens: 4 }, true],
      ['recordUsage', '$p0', { totalTokens: 10 }, false],
      ['recordUsage', 'openai', undefined, true],
      ['usage'],
      ['state'],
      ['flush'],
      [
        'recordCall',
        {
          providerId: 'p',
          model: 'm',
          at: 1,
          durationMs: 2,
          inputTokens: 1,
          outputTokens: 2,
          estimated: false,
        },
      ],
      ['resetUsage', '$p0'],
      ['resetUsage'],
      ['has', '$p1'],
      ['remove', '$p0'],
      ['remove', '$p0'],
      ['reload'],
    ],
  },
  {
    name: 'memory',
    file: false,
    env: { CLAUDE_API_KEY: 'c', GEMINI_API_KEY: 'g' },
    ops: [
      ['upsert', { presetId: 'openrouter', apiKey: 'sk-or-12345678901234' }],
      ['setActive', 'claude', 'x'],
      ['setActive', 'gemini'],
      ['markKey', '$p0', 0],
      ['recordUsage', 'gemini', { inputTokens: 1 }, true],
      ['state'],
      ['remove', 'ghost'],
    ],
  },
  {
    name: 'migrate-v1',
    file: true,
    initial: JSON.stringify(raws[2]),
    ops: [['state'], ['setActive', 'a'], ['reload']],
  },
  { name: 'corrupt', file: true, initial: '{not json', ops: [['state']] },
  {
    name: 'v2',
    file: true,
    initial: JSON.stringify(raws[1], null, 1),
    ops: [
      ['setActive', 'x'],
      ['upsert', { presetId: 'custom', baseURL: 'http://a' }],
    ],
  },
];
const runs = scripts.map((sc) => ({
  name: sc.name,
  env: sc.env ?? {},
  file: sc.file,
  initial: sc.initial ?? null,
  ops: sc.ops.map((o) => o.map((x) => (x === undefined ? '__undefined__' : x))),
  steps: runScript(sc),
}));

// Mask generated ids in order of first appearance.
function maskIds(s) {
  const seen = new Map();
  return s.replace(/\b(p-[a-z0-9-]+?-|k-)([0-9a-f]{8})\b/g, (_, pre, hex) => {
    if (!seen.has(hex)) seen.set(hex, `#${seen.size}`);
    return `${pre}${seen.get(hex)}`;
  });
}

mkdirSync(outDir, { recursive: true });
const data = {
  protocol: { proto, headers, parsed, maps, labels: protocol.PROTOCOL_LABELS },
  masks,
  searches,
  categories: presets.PRESET_CATEGORY_LABELS,
  envs,
  migrate,
  runs: runs.map((r) => ({ ...r, steps: JSON.parse(maskIds(JSON.stringify(r.steps))) })),
};
writeFileSync(
  join(outDir, 'providers.json.gz'),
  gzipSync(JSON.stringify(data) + '\n', { level: 9 }),
);
console.log('wrote providers.json.gz', existsSync(outDir));
