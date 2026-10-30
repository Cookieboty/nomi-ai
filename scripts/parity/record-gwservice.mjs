#!/usr/bin/env node
/**
 * GatewayService 写操作 / state() / runtimeConfig / nomiRoute / 隐私 / learn / keyStatus / 本地模型登记（D-B4d-6、D-B5-GW-1、D-B8-2）golden：
 * 真实 GatewayService（假 proc、确定性时钟 / uuid / randomBytes / 密码器）按脚本逐步调用，每步录下返回值或错误、
 * state()（去掉 status）、runtimeConfig()、nomiRoute('main'|'tools')，最后录下目录。
 * 「local」场景按 LocalModelService.registerInGateway + useAsChat 的调用顺序驱动网关（Go 侧走 shellhandlers.LocalGateway）。
 * Go 侧 apps/desktop-go/internal/core/gwstore/service_parity_test.go 与 shellhandlers/gateway_local_test.go 回放比对。
 * Usage: TZ=Asia/Shanghai npx tsx scripts/parity/record-gwservice.mjs   （NOMI_GOLDEN_DIR 设置时写到该目录）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Windows 上 shell 前缀的 TZ= 不一定传到 Node：脚本自己设（Node 运行时修改 TZ 立即生效）
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

const enc = (p) => Buffer.from('ss:' + p).toString('base64');
const dec = (s) => {
  const t = Buffer.from(s, 'base64').toString('utf8');
  if (!t.startsWith('ss:')) throw new Error('bad');
  return t.slice(3);
};
const cipher = { kind: 'safeStorage', encrypt: enc, decrypt: dec };
const fakeProc = {
  send() {},
  bindTabs() {},
  ensureStarted() {},
  getStatus: () => ({ state: 'stopped' }),
  apply() {},
  whenReady: async () => true,
  stop() {},
  retry() {},
};
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

function service(ud) {
  return new GatewayService({
    root: join(ud, 'gateway'),
    cipher,
    logger: { info() {}, warn() {} },
    process: fakeProc,
    lazy: true,
    port: 18999,
    env: {},
    envProviders,
  });
}

function tree(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d).sort()) {
      const p = join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else
        out[relative(dir, p).split('\\').join('/')] = fs
          .readFileSync(p, 'utf8')
          .split(dir)
          .join('<UD>');
    }
  };
  walk(dir);
  return out;
}
const clean = (v, ud) =>
  JSON.parse(
    JSON.stringify(v ?? null)
      .split(JSON.stringify(ud).slice(1, -1))
      .join('<UD>'),
  );

const scenarios = [];
async function scenario(name, ops) {
  const ud = fs.mkdtempSync(join(os.tmpdir(), 'gwsvc-'));
  clock = 1793500000000;
  uuid = 0;
  rb = 0;
  const s = service(ud);
  s.init();
  const steps = [];
  for (const [op, ...args] of ops) {
    clock += 1000;
    const rec = { op, args };
    try {
      let r;
      if (op === 'local.register') r = localRegister(s, ...args);
      else if (op === 'local.useAsChat') r = s.setAssignment('nomi', { models: { main: args[0] } });
      else r = await s[op](...args);
      rec.result = r === undefined ? null : r;
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
    }
    const { status: _s, ...st } = s.state();
    rec.state = st;
    rec.runtimeConfig = s.runtimeConfig();
    rec.nomiMain = s.nomiRoute('main') ?? null;
    rec.nomiTools = s.nomiRoute('tools') ?? null;
    steps.push(clean(rec, ud));
  }
  s.dispose();
  await new Promise((r) => setTimeout(r, 50));
  scenarios.push({ name, steps, files: tree(ud) });
}

/** LocalModelService.registerInGateway 的网关调用（apps/desktop-electron/internal/core/src/local/LocalModelService.ts） */
function localRegister(gw, modelId, baseURL, gatewayProviderId) {
  const u = new URL(baseURL);
  gw.confirmPrivateHost(`${u.hostname}:${u.port || '80'}`);
  const existing = gw
    .state()
    .providers.find((p) => p.id === gatewayProviderId || p.presetId === 'llamacpp');
  const v = gw.upsertProvider({
    ...(existing ? { id: existing.id } : {}),
    name: 'Local model',
    presetId: 'llamacpp',
    urls: { chat: baseURL },
    models: [{ id: modelId, enabled: true }],
  });
  return v.id;
}

await scenario('providers + assignments + options', [
  ['upsertProvider', { name: '  ' }],
  ['upsertProvider', { id: 'nope', name: 'X' }],
  [
    'upsertProvider',
    {
      name: 'My Proxy',
      urls: { chat: ' https://proxy.example.com/v1 ', messages: '' },
      newKeys: [
        { value: ' sk-proxy-aaaaaaaaaaaa ', name: 'main', rpm: 60, tpm: 1000 },
        { value: '   ' },
        { value: 'sk-proxy-bbbbbbbbbbbb', position: 0, enabled: false, concurrency: 2 },
      ],
      models: [
        { id: 'gpt-4o', enabled: true, effective: { x: 1 } },
        { id: 'gpt-4o-mini', enabled: false },
      ],
      headers: { 'X-A': '1' },
      userAgent: '',
    },
  ],
  [
    'upsertProvider',
    {
      name: 'DeepSeek',
      presetId: 'deepseek',
      urls: { chat: 'https://api.deepseek.com/v1' },
      newKeys: [{ value: 'sk-ds-1234567890' }],
      models: [{ id: 'deepseek-chat', enabled: true }],
    },
  ],
  [
    'upsertProvider',
    {
      id: 'my-proxy',
      name: 'My Proxy 2',
      keys: [{ id: 'k-00000002', enabled: true, name: 'renamed', wire: 'chat', rpm: 5 }],
      newKeys: [{ value: 'sk-new-cccccccccccc', position: 9 }],
      urls: { responses: 'https://proxy.example.com/v1/responses' },
      userAgent: 'ua/1',
      enabled: false,
    },
  ],
  [
    'setAssignment',
    'nomi',
    { models: { main: 'deepseek/deepseek-chat', tools: 'my-proxy/gpt-4o' } },
  ],
  ['setAssignment', 'nomi', { models: { main: 'my-proxy/gpt-4o' } }],
  ['setAssignment', 'nomi', { models: { main: 'deepseek/deepseek-chat' } }],
  ['setAssignment', 'claude', { models: { main: 'deepseek/deepseek-chat' } }],
  ['setAssignment', 'codex', { models: { main: null } }],
  [
    'setAssignment',
    'gemini',
    { newTabSource: 'official', models: { small: 'deepseek/deepseek-chat' } },
  ],
  ['setAssignment', 'grok', { newTabSource: 'thirdParty', newTabAccountId: 'acc-1' }],
  ['resetToken', 'codex'],
  [
    'setOptions',
    {
      strictParams: true,
      maxRequestBodyBytes: 1,
      privacyMode: false,
      privacyStrict: true,
      privacyLocal: false,
      privacyShape: true,
    },
  ],
  [
    'setOptions',
    { strictParams: false, maxRequestBodyBytes: 1e12, privacyMode: true, privacyShape: false },
  ],
  ['setOptions', { nothing: 1 }],
  ['confirmPrivateHost', '192.168.1.20:8000'],
  ['confirmPrivateHost', '192.168.1.20:8000'],
  ['removeProvider', 'env-deepseek'],
  ['removeProvider', 'missing'],
  ['removeProvider', 'my-proxy'],
]);

await scenario('privacy', [
  ['setPrivacyAction', 'API_KEY', 'warn'],
  ['setPrivacyAction', 'PASSWORD', 'block'],
  ['setPrivacyAction', 'API_KEY', 'mask'],
  ['setPrivacyAction', 'bogus', 'mask'],
  ['setPrivacyAction', 'TOKEN', 'bogus'],
  ['addPrivacySecret', { name: 'db', value: 'hunter2-super-secret' }],
  ['addPrivacySecret', { name: '', value: 'x' }],
  ['addPrivacySecret', 'nope'],
  ['addPrivacyAllow', { tag: 'EMAIL', value: 'me@example.com' }],
  ['addPrivacyAllow', { value: 'me@example.com' }],
  [
    'previewPrivacy',
    'key sk-proj-abcdefghijklmnopqrstuvwxyz0123 token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ],
  [
    'previewPrivacy',
    'mail me@example.com or bob@example.org, pw hunter2-super-secret, phone 13800138000',
  ],
  ['previewPrivacy', 42],
  ['removePrivacySecret', 's-00000001'],
  ['removePrivacyAllow', 'nope'],
  ['setOptions', { privacyMode: false }],
  ['previewPrivacy', 'bob@example.org'],
]);

await scenario('learn with at', [
  [
    'upsertProvider',
    {
      name: 'P',
      urls: { chat: 'https://p.example.com/v1' },
      models: [{ id: 'm1', enabled: true }],
    },
  ],
  [
    'learn',
    {
      type: 'model-efforts',
      providerId: 'p',
      model: 'm1',
      efforts: ['bogus', 'medium'],
      catalogVersion: 'v2',
      at: 1700000000000,
    },
  ],
  [
    'learn',
    {
      type: 'model-efforts',
      providerId: 'p',
      model: 'm1',
      efforts: ['medium'],
      catalogVersion: 'v2',
      at: 1,
    },
  ],
  [
    'learn',
    {
      type: 'model-efforts',
      providerId: 'p',
      model: 'm1',
      efforts: ['bogus'],
      catalogVersion: 'v3',
    },
  ],
  ['learn', { type: 'unknown-type', providerId: 'p' }],
]);

await scenario('learn + keyStatus + clearLearned', [
  [
    'upsertProvider',
    {
      name: 'P',
      urls: { chat: 'https://p.example.com/v1', responses: 'https://p.example.com/v1/responses' },
      newKeys: [{ value: 'sk-p-1234567890' }],
      models: [{ id: 'm1', enabled: true }],
    },
  ],
  ['learn', { type: 'dropped-param', providerId: 'p', wire: 'chat', param: 'temperature' }],
  ['learn', { type: 'dropped-param', providerId: 'p', wire: 'chat', param: 'temperature' }],
  ['learn', { type: 'model-wire', providerId: 'p', model: 'm1', exclude: 'responses' }],
  ['learn', { type: 'custom-tools-refused', providerId: 'p', model: 'm1' }],
  [
    'learn',
    {
      type: 'model-efforts',
      providerId: 'p',
      model: 'm1',
      efforts: ['low', 'high'],
      catalogVersion: 'v1',
    },
  ],
  ['learn', { type: 'dropped-param', providerId: 'missing', wire: 'chat', param: 'x' }],
  [
    'keyStatus',
    { providerId: 'p', keyId: 'k-00000001', wire: 'chat', status: 'auth', error: '401 bad key' },
  ],
  ['keyStatus', { providerId: 'p', keyId: 'k-00000001', wire: 'chat', status: 'ok' }],
  ['keyStatus', { providerId: 'p', keyId: 'missing', wire: 'chat', status: 'auth', error: 'x' }],
  ['clearLearned', 'p'],
]);

await scenario('local model registration (D-B8-2)', [
  ['local.register', 'qwen3-4b', 'http://127.0.0.1:39281/v1', undefined],
  ['local.useAsChat', 'llamacpp/qwen3-4b'],
  ['local.register', 'llama3-8b', 'http://127.0.0.1:39282/v1', 'llamacpp'],
  ['local.useAsChat', 'llamacpp/llama3-8b'],
  ['local.register', 'x', 'http://localhost/v1', 'gone'],
]);

const dir =
  process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/gwstore/testdata');
fs.mkdirSync(dir, { recursive: true });
const out = join(dir, 'gwservice.json');
fs.writeFileSync(out, JSON.stringify({ scenarios }, null, 1));
console.log('wrote', out, scenarios.length);
