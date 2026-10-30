#!/usr/bin/env node
/**
 * GatewayService 编程助手方法 golden（D-B5-GW-2）：cliDefaults / cliModels / cliLaunch / cliLaunchForTab /
 * releaseTab / releaseAgent / officialEnv。真实 GatewayService + 真实 GatewayProcess（假 fork：binding 消息按
 * 真实 BindingTable 应答，listening 由脚本触发）+ 确定性时钟 / uuid / randomBytes；HOME 指向临时目录。
 * 每步录下返回值或错误、网关状态、发给网关的 binding 消息类型，最后录下用户目录（不跟随软链）。
 * Go 侧 apps/desktop-go/internal/core/gwstore/service_cli_parity_test.go 回放比对。
 * Usage: npx tsx scripts/parity/record-gwcli.mjs   （NOMI_GOLDEN_DIR 设置时写到该目录）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TZ = 'Asia/Shanghai';
if (new Date(0).getTimezoneOffset() !== -480) throw new Error('TZ=Asia/Shanghai not applied');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

let clock = 1793500000000;
Date.now = () => clock;
let uuid = 0,
  rb = 0;
crypto.randomUUID = () => {
  const n = (++uuid).toString(16).padStart(8, '0');
  return `${n}-0000-4000-8000-000000000000`;
};
crypto.randomBytes = (n) => {
  rb++;
  return Buffer.alloc(n, rb);
};
syncBuiltinESMExports();

const { GatewayService } = await imp(
  'apps/desktop-electron/internal/core/src/gateway/GatewayService.ts',
);
const { GatewayProcess } = await imp(
  'apps/desktop-electron/internal/core/src/gateway/GatewayProcess.ts',
);
const { BindingTable } = await imp('apps/desktop-electron/internal/gateway/src/route/binding.ts');
const { whenPrivateWritesIdle } = await imp(
  'apps/desktop-electron/internal/core/src/utils/privateFile.ts',
);

const enc = (p) => Buffer.from('ss:' + p).toString('base64');
const dec = (s) => {
  const t = Buffer.from(s, 'base64').toString('utf8');
  if (!t.startsWith('ss:')) throw new Error('bad');
  return t.slice(3);
};
const cipher = { kind: 'safeStorage', encrypt: enc, decrypt: dec };
const logger = { info() {}, warn() {} };
const envProviders = () => [
  {
    id: 'deepseek',
    name: 'DeepSeek (env)',
    wire: 'chat',
    url: 'https://api.deepseek.com/v1',
    key: 'sk-env-deepseek-123456',
    keyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
  },
];

function tree(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d).sort()) {
      const p = join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile())
        out[relative(dir, p).split('\\').join('/')] = udSub(fs.readFileSync(p, 'utf8'), dir);
    }
  };
  walk(dir);
  return out;
}
// Replace the data dir at every JSON/TOML escape depth (deepest first): on Windows a
// path nested in a quoted CLI arg is backslash-escaped twice inside the golden.
function udSub(s, ud) {
  for (let k = 3; k >= 0; k--) s = s.split(ud.split('\\').join('\\'.repeat(2 ** k))).join('<UD>');
  return s;
}
const clean = (v, ud) => JSON.parse(udSub(JSON.stringify(v ?? null), ud));

// helperComplete 的上游桩：按请求里的 model 返回不同响应；记下收到的请求
const stub = { port: 0, last: null };
const STUB = {
  ok: [200, JSON.stringify({ choices: [{ message: { content: 'héllo 😀 <&>' } }] })],
  nonstr: [200, '{"choices":[{"message":{"content":5}}]}'],
  bom: [200, '\ufeff{"choices":[{"message":{"content":"b"}}]}'],
  notjson: [200, 'nope'],
  objchoices: [200, '{"choices":{"0":{"message":{"content":"obj"}}}}'],
  nochoices: [200, '{"x":1}'],
  nullj: [200, 'null'],
  boom: [503, 'e'.repeat(499) + '😀tail'],
  short: [401, 'bad key'],
};
{
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      b += c;
    });
    req.on('end', () => {
      stub.last = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: b,
      };
      let model = '';
      try {
        model = JSON.parse(b).model;
      } catch {
        /* ignore */
      }
      const [st, text] = STUB[model] ?? [404, 'no such model'];
      res.writeHead(st, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  stub.port = srv.address().port;
  srv.unref();
}

const CLI_ENV = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'GROK_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
];

const scenarios = [];
async function scenario(name, ops) {
  const ud = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'gwcli-')));
  const home = join(ud, 'home');
  fs.mkdirSync(join(home, '.codex'), { recursive: true });
  fs.mkdirSync(join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    join(home, '.codex', 'models_cache.json'),
    JSON.stringify({
      models: [
        {
          slug: 'gpt-5',
          display_name: 'GPT-5',
          base_instructions: 'be nice',
          priority: 9,
          input_modalities: ['text', 'image'],
          supported_reasoning_levels: [{ effort: 'low' }],
          default_reasoning_level: 'medium',
        },
      ],
    }),
  );
  fs.writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ theme: 'dark', env: { ANTHROPIC_BASE_URL: 'https://evil.example.com' } }),
  );
  const saved = Object.fromEntries(CLI_ENV.map((k) => [k, process.env[k]]));
  for (const k of CLI_ENV) delete process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clock = 1793500000000;
  uuid = 0;
  rb = 0;
  let sent = [];
  let child = null;
  const table = new BindingTable();
  const fork = () => {
    const c = { msg: null };
    child = c;
    return {
      postMessage: (m) => {
        if (m.type.startsWith('binding:')) {
          sent.push(m.type);
          const ack = table.handle(m);
          queueMicrotask(() => c.msg?.(ack));
        }
      },
      on: (e, fn) => {
        if (e === 'message') c.msg = fn;
      },
      kill: () => true,
    };
  };
  const s = new GatewayService({
    root: join(ud, 'gateway'),
    cipher,
    logger,
    lazy: true,
    port: 18999,
    env: {},
    envProviders,
    process: undefined,
  });
  // 换上假 fork 的真实 GatewayProcess（同构造函数里的接法）
  const proc = new GatewayProcess({ logger, lazy: true, fork, onStatus: () => {} });
  s.proc = proc;
  s.tabs = new s.tabs.constructor({ send: (m) => proc.send(m), logger });
  proc.bindTabs({ ack: (m) => s.tabs.onAck(m), spawn: () => s.tabs.replay() });
  s.init();
  const steps = [];
  for (const [op, ...args] of ops) {
    clock += 1000;
    sent = [];
    const rec = { op, args };
    try {
      let r;
      if (op === 'officialEnvTok')
        r = s.officialEnv({ ...args[0], T: `x ${s.store.clientToken(args[1])} y` });
      else if (op === 'applyModelsDataN') r = await s.applyModelsData(modelsApi(args[0]));
      else if (op === 'storeProvider') r = s.store.upsertProvider(args[0]);
      else if (op === 'writeSessions') {
        fs.mkdirSync(join(ud, 'gateway'), { recursive: true });
        fs.writeFileSync(join(ud, 'gateway', 'sessions.json'), args[0]);
      } else if (op === 'stubListen')
        r = child?.msg?.({
          type: 'listening',
          port: stub.port,
          url: `http://127.0.0.1:${stub.port}`,
        });
      else if (op === 'helperComplete') {
        stub.last = null;
        try {
          r = { value: await s.helperComplete(args[0], args[1], new AbortController().signal) };
        } catch (e) {
          r = { error: e instanceof Error ? e.message : String(e) };
        }
        r.req = stub.last;
      } else if (op === 'listen')
        r = child?.msg?.({ type: 'listening', port: 18999, url: 'http://127.0.0.1:18999' });
      else r = await s[op](...args);
      rec.result = r === undefined ? null : r;
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setImmediate(r));
    rec.status = s.proc.getStatus().state;
    rec.sent = sent;
    steps.push(clean(rec, ud));
  }
  s.dispose();
  // dispose 时隐私日志等是异步落盘：等写队列清空再采集文件（Windows runner 上 50 ms 不够，录出的 golden 会缺文件）
  await whenPrivateWritesIdle();
  await new Promise((r) => setTimeout(r, 50));
  for (const k of CLI_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  scenarios.push({ name, steps, files: tree(ud) });
}

await scenario('cli methods', [
  ['cliDefaults', 'claude'],
  ['cliModels'],
  [
    'upsertProvider',
    {
      name: 'My Proxy',
      urls: { chat: 'https://proxy.example.com/v1' },
      newKeys: [{ value: 'sk-proxy-aaaaaaaaaaaa' }],
      models: [
        {
          id: 'gpt-4o',
          enabled: true,
          label: 'GPT 4o',
          reasoning: true,
          vision: true,
          ctx: 200000,
          maxOutput: 64000,
        },
        { id: 'gpt-4o-mini', enabled: false },
        { id: 'no-tools', enabled: true, toolCalling: false },
        { id: 'plain', enabled: true },
      ],
    },
  ],
  [
    'upsertProvider',
    {
      name: 'Off',
      enabled: false,
      urls: { chat: 'https://off.example.com/v1' },
      models: [{ id: 'x', enabled: true }],
    },
  ],
  ['cliModels'],
  [
    'setAssignment',
    'claude',
    {
      newTabSource: 'thirdParty',
      newTabAccountId: 'acc-1',
      models: {
        main: 'my-proxy/gpt-4o',
        tiers: { opus: 'my-proxy/plain' },
        small: 'env-deepseek/deepseek-chat',
        subagent: 'my-proxy/plain',
      },
    },
  ],
  ['setAssignment', 'gemini', { newTabSource: 'official', newTabAccountId: 'acc-2' }],
  ['setAssignment', 'grok', { newTabSource: 'thirdParty' }],
  ['cliDefaults', 'claude'],
  ['cliDefaults', 'gemini'],
  ['cliDefaults', 'grok'],
  ['cliDefaults', 'codex'],
  ['cliDefaults', 'bogus'],
  ['cliLaunch', 'bogus', 't1', 'my-proxy/gpt-4o'],
  ['cliLaunch', 'claude', 't1', 'my-proxy/gpt-4o', {}],
  ['cliLaunch', 'claude', 't1', 'my-proxy/plain', { longContext: true }],
  ['cliLaunch', 'codex', 'tab/2 é😀', 'my-proxy/gpt-4o', { longContext: false }],
  ['cliLaunch', 'gemini', 't3', 'env-deepseek/deepseek-chat'],
  ['cliLaunch', 'dsh', 't4', 'my-proxy/gpt-4o'],
  ['cliLaunch', 'dsh', 't5', 'nope/unknown'],
  ['cliLaunch', 'grok', 't6', 'my-proxy/gpt-4o'],
  ['cliLaunch', 'grok', 't7', 'my-proxy/gpt-4o', { tabBound: true }],
  ['listen'],
  ['cliLaunchForTab', 'grok', 't8', 'my-proxy/gpt-4o', 'high'],
  ['cliLaunchForTab', 'grok', 't8', 'my-proxy/plain', undefined, true],
  ['cliLaunchForTab', 'claude', 't9', 'my-proxy/gpt-4o', '', false],
  ['cliLaunchForTab', 'bogus', 't9', 'my-proxy/gpt-4o'],
  ['releaseTab', 'grok', 't8', 1],
  ['releaseTab', 'grok', 't8', 2],
  ['releaseTab', 'grok', 't8'],
  ['releaseTab', 'claude', 't9'],
  ['releaseAgent', 'grok', 't8'],
  ['releaseAgent', 'claude', 'missing'],
  [
    'officialEnv',
    {
      A: 'http://127.0.0.1:18999',
      B: 'http://127.0.0.1:18999/v1',
      C: 'http://127.0.0.1:18999/',
      D: 'nomi-tab-abc',
      E: 'nomi-gw-x',
      F: 'keep',
      G: '',
      H: 'http://127.0.0.1:18999/v2',
      I: 'nomi-tabx',
    },
  ],
  ['officialEnvTok', { F: 'keep' }, 'codex'],
  ['resetToken', 'claude'],
]);

await scenario('officialEnv stopped', [
  ['officialEnv', { A: 'http://127.0.0.1:18999', F: 'keep' }],
  ['cliLaunch', 'gemini', 't1', 'x/y'],
  ['officialEnv', { A: 'http://127.0.0.1:18999/', F: 'keep' }],
]);

// 非布尔 enabled（store 层原样写入，不经 upsertProvider 规范化）：Node 按真值判断
const rawModels = [
  { id: 'a', enabled: 'yes', label: null },
  { id: 'b', enabled: 0 },
  { id: 'c', enabled: '' },
  { id: 'd', enabled: null },
  { id: 'e', enabled: 1, toolCalling: 0 },
  { id: 'f', enabled: {}, toolCalling: null, label: 'F' },
  { id: 'g', enabled: 'false' },
];
await scenario('truthy enabled', [
  [
    'storeProvider',
    {
      id: 'raw1',
      name: 'Raw 1',
      enabled: 1,
      wire: 'chat',
      urls: { chat: 'https://raw1.example.com/v1' },
      keys: [],
      models: rawModels,
    },
  ],
  [
    'storeProvider',
    {
      id: 'raw2',
      name: 'Raw 2',
      enabled: 'on',
      wire: 'chat',
      urls: { chat: 'https://raw2.example.com/v1' },
      keys: [],
      models: [{ id: 'z', enabled: true }],
    },
  ],
  [
    'storeProvider',
    {
      id: 'raw3',
      name: 'Raw 3',
      enabled: 0,
      wire: 'chat',
      urls: { chat: 'https://raw3.example.com/v1' },
      keys: [],
      models: [{ id: 'z', enabled: true }],
    },
  ],
  [
    'storeProvider',
    {
      id: 'raw4',
      name: 'Raw 4',
      enabled: '',
      wire: 'chat',
      urls: { chat: 'https://raw4.example.com/v1' },
      keys: [],
      models: [{ id: 'z', enabled: true }],
    },
  ],
  [
    'storeProvider',
    {
      id: 'raw5',
      name: 'Raw 5',
      wire: 'chat',
      urls: { chat: 'https://raw5.example.com/v1' },
      keys: [],
      models: [{ id: 'z', enabled: true }],
    },
  ],
  ['cliModels'],
  ['cliLaunch', 'claude', 't1', 'raw1/a'],
  ['cliLaunch', 'gemini', 't2', 'raw1/f'],
]);

const SESS = (list) => JSON.stringify({ version: 1, sessions: list });
await scenario('helpers', [
  ['helperRoute', 'claude', null],
  ['helperRoute', 'claude', 'env-deepseek/deepseek-chat'],
  [
    'upsertProvider',
    {
      name: 'DS',
      urls: { chat: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-d-1234567890' }],
      models: [
        { id: 'deepseek-v4-flash', enabled: true },
        { id: 'deepseek-v4-pro', enabled: true },
      ],
    },
  ],
  [
    'upsertProvider',
    {
      name: 'Loc',
      urls: { chat: 'http://127.0.0.1:11434/v1' },
      models: [{ id: 'q', enabled: true }],
    },
  ],
  ['helperRoute', 'claude', 'ds/deepseek-v4-pro'],
  ['helperRoute', 'claude', 'loc/q'],
  ['confirmPrivateHost', '127.0.0.1:11434'],
  ['helperRoute', 'claude', 'loc/q'],
  ['helperRoute', 'claude', 'nope/x'],
  [
    'setAssignment',
    'claude',
    { models: { main: 'ds/deepseek-v4-pro', tiers: { haiku: 'ds/deepseek-v4-flash' } } },
  ],
  ['helperRoute', 'claude', 'nope/x'],
  [
    'setAssignment',
    'claude',
    { models: { main: 'ds/deepseek-v4-pro', summary: 'loc/q', small: 'nope/z' } },
  ],
  ['helperRoute', 'claude', null],
  [
    'setAssignment',
    'claude',
    { models: { main: 'ds/deepseek-v4-pro', summary: 'nope/y', small: 'loc/q' } },
  ],
  ['helperRoute', 'claude', 'ds/deepseek-v4-flash'],
  ['setAssignment', 'claude', { models: { main: 'nope/m' } }],
  ['helperRoute', 'claude', null],
  ['helperRoute', 'codex', null],
  ['helperRoute', 'gemini', 'ds/deepseek-v4-flash'],
  ['helperRoute', 'nomi', null],
  ['helperRoute', 'bogus', 'ds/deepseek-v4-flash'],
  ['servedSession', 'claude', 's1'],
  ['servedSessionRef', 'claude', 's1'],
  [
    'writeSessions',
    SESS([
      ['x', 1],
      'str',
      ['claude:cc:s1', { providerId: 'p', model: 'ds/deepseek-v4-pro' }],
      ['claude:cc:s2', null],
      ['claude:cc:s3', { model: 'nomodel' }],
      ['claude:cc:s4', 7],
      ['claude:cc:s5'],
      ['claude:cc:s6', { model: 5 }],
      ['claude:cc:s1', { model: 'later/x' }],
    ]),
  ],
  ['servedSession', 'claude', 's1'],
  ['servedSessionRef', 'claude', 's1'],
  ['servedSession', 'claude', 's2'],
  ['servedSessionRef', 'claude', 's2'],
  ['servedSessionRef', 'claude', 's3'],
  ['servedSession', 'claude', 's4'],
  ['servedSessionRef', 'claude', 's4'],
  ['servedSession', 'claude', 's5'],
  ['servedSessionRef', 'claude', 's6'],
  ['servedSession', 'claude', 's9'],
  ['servedSession', 'codex', 's1'],
  ['servedSession', 'claude', ''],
  ['writeSessions', SESS([5, ['claude:cc:s1', {}]])],
  ['servedSession', 'claude', 's1'],
  ['writeSessions', SESS([['claude:cc:s1', {}], 5])],
  ['servedSession', 'claude', 's1'],
  ['writeSessions', SESS([{}, ['claude:cc:s1', {}]])],
  ['servedSession', 'claude', 's1'],
  ['writeSessions', 'null'],
  ['servedSession', 'claude', 's1'],
  ['writeSessions', '{"sessions":{}}'],
  ['servedSession', 'claude', 's1'],
  ['writeSessions', '{"sessions":null}'],
  ['servedSession', 'claude', 's1'],
  ['writeSessions', '[]'],
  ['servedSession', 'claude', 's1'],
  ['writeSessions', 'garbage'],
  ['servedSession', 'claude', 's1'],
  ['endpoint', 'nomi'],
  ['stubListen'],
  [
    'helperComplete',
    'ok',
    [
      { role: 'system', content: 'sys "q" <b>\u2028' },
      { role: 'user', content: 'hi 😀' },
    ],
  ],
  ['helperComplete', 'nonstr', []],
  ['helperComplete', 'bom', [{ role: 'user', content: 'x' }]],
  ['helperComplete', 'notjson', [{ role: 'user', content: 'x' }]],
  ['helperComplete', 'objchoices', [{ role: 'user', content: 'x' }]],
  ['helperComplete', 'nochoices', [{ role: 'user', content: 'x' }]],
  ['helperComplete', 'nullj', [{ role: 'user', content: 'x' }]],
  ['helperComplete', 'boom', [{ role: 'user', content: 'x' }]],
  ['helperComplete', 'short', [{ role: 'user', content: 'x' }]],
  ['helperComplete', 'missing', [{ role: 'user', content: 'x' }]],
]);

// 模型目录同步（applyModelsData）：models.dev 形状的 n 个模型（Go 侧同一生成器）；new Date() 指向假时钟
function modelsApi(n) {
  const models = {};
  for (let i = 0; i < n; i++) {
    models[`m-${String(i).padStart(3, '0')}`] = {
      id: `m-${i}`,
      name: `M ${i}`,
      reasoning: i % 2 === 0,
      modalities: { input: i % 3 === 0 ? ['text', 'image'] : ['text'] },
      limit: { context: 100000 + i * 1000, output: 4096 + i },
    };
  }
  models.plain = { id: 'plain', name: 'Plain', limit: { context: 777000, output: 33000 } };
  models.embed = { id: 'embed', type: 'embedding', limit: { context: 8000 } };
  return { openai: { models } };
}
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length) super(...a);
    else super(clock);
  }
  static now() {
    return clock;
  }
};
await scenario('catalog sync', [
  [
    'upsertProvider',
    {
      name: 'My Proxy',
      urls: { chat: 'https://proxy.example.com/v1' },
      newKeys: [{ value: 'sk-proxy-aaaaaaaaaaaa' }],
      models: [
        { id: 'plain', enabled: true },
        { id: 'm-001', enabled: true },
      ],
    },
  ],
  ['hasCatalogSync'],
  ['cliModels'],
  ['applyModelsDataN', 5],
  ['hasCatalogSync'],
  ['applyModelsDataN', 120],
  ['hasCatalogSync'],
  ['cliModels'],
  ['modelMetaOf', 'my-proxy/plain'],
  ['cliLaunch', 'claude', 't1', 'my-proxy/plain'],
]);
globalThis.Date = RealDate;

const dir =
  process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/gwstore/testdata');
fs.mkdirSync(dir, { recursive: true });
const out = join(dir, 'gwcli.json');
fs.writeFileSync(out, JSON.stringify({ scenarios }, null, 1));
console.log('wrote', out, scenarios.length);
