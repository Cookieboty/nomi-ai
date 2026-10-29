#!/usr/bin/env node
/**
 * GatewayService 编程助手方法 golden（D-B5-GW-2）：cliDefaults / cliModels / cliLaunch / cliLaunchForTab /
 * releaseTab / releaseAgent / officialEnv。真实 GatewayService + 真实 GatewayProcess（假 fork：binding 消息按
 * 真实 BindingTable 应答，listening 由脚本触发）+ 确定性时钟 / uuid / randomBytes；HOME 指向临时目录。
 * 每步录下返回值或错误、网关状态、发给网关的 binding 消息类型，最后录下用户目录（不跟随软链）。
 * Go 侧 apps/desktop-go/internal/core/gwstore/service_cli_parity_test.go 回放比对。
 * Usage: npx tsx scripts/parity/record-gwcli.mjs   （NOMI_GOLDEN_DIR 设置时写到该目录）
 */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TZ = 'Asia/Shanghai';
if (new Date(0).getTimezoneOffset() !== -480) throw new Error('TZ=Asia/Shanghai not applied');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

let clock = 1793500000000;
Date.now = () => clock;
let uuid = 0, rb = 0;
crypto.randomUUID = () => { const n = (++uuid).toString(16).padStart(8, '0'); return `${n}-0000-4000-8000-000000000000`; };
crypto.randomBytes = (n) => { rb++; return Buffer.alloc(n, rb); };
syncBuiltinESMExports();

const { GatewayService } = await imp('packages/core/src/gateway/GatewayService.ts');
const { GatewayProcess } = await imp('packages/core/src/gateway/GatewayProcess.ts');
const { BindingTable } = await imp('packages/gateway/src/route/binding.ts');

const enc = (p) => Buffer.from('ss:' + p).toString('base64');
const dec = (s) => { const t = Buffer.from(s, 'base64').toString('utf8'); if (!t.startsWith('ss:')) throw new Error('bad'); return t.slice(3); };
const cipher = { kind: 'safeStorage', encrypt: enc, decrypt: dec };
const logger = { info() {}, warn() {} };
const envProviders = () => [
  { id: 'deepseek', name: 'DeepSeek (env)', wire: 'chat', url: 'https://api.deepseek.com/v1', key: 'sk-env-deepseek-123456', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
];

function tree(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const n of fs.readdirSync(d).sort()) {
      const p = join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out[relative(dir, p).split('\\').join('/')] = fs.readFileSync(p, 'utf8').split(JSON.stringify(dir).slice(1, -1)).join('<UD>').split(dir).join('<UD>');
    }
  };
  walk(dir);
  return out;
}
const clean = (v, ud) => JSON.parse(JSON.stringify(v ?? null).split(JSON.stringify(ud).slice(1, -1)).join('<UD>'));

const CLI_ENV = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME'];

const scenarios = [];
async function scenario(name, ops) {
  const ud = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'gwcli-')));
  const home = join(ud, 'home');
  fs.mkdirSync(join(home, '.codex'), { recursive: true });
  fs.mkdirSync(join(home, '.claude'), { recursive: true });
  fs.writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5', display_name: 'GPT-5', base_instructions: 'be nice', priority: 9, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'medium' }] }));
  fs.writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', env: { ANTHROPIC_BASE_URL: 'https://evil.example.com' } }));
  const saved = Object.fromEntries(CLI_ENV.map((k) => [k, process.env[k]]));
  for (const k of CLI_ENV) delete process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home;
  clock = 1793500000000; uuid = 0; rb = 0;
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
      on: (e, fn) => { if (e === 'message') c.msg = fn; },
      kill: () => true,
    };
  };
  const s = new GatewayService({
    root: join(ud, 'gateway'), cipher, logger, lazy: true, port: 18999, env: {}, envProviders,
    process: undefined,
  });
  // 换上假 fork 的真实 GatewayProcess（同构造函数里的接法）
  const proc = new GatewayProcess({ logger, lazy: true, fork, onStatus: () => {} });
  s.proc = proc;
  s.tabs = new (s.tabs.constructor)({ send: (m) => proc.send(m), logger });
  proc.bindTabs({ ack: (m) => s.tabs.onAck(m), spawn: () => s.tabs.replay() });
  s.init();
  const steps = [];
  for (const [op, ...args] of ops) {
    clock += 1000;
    sent = [];
    const rec = { op, args };
    try {
      let r;
      if (op === 'officialEnvTok') r = s.officialEnv({ ...args[0], T: `x ${s.store.clientToken(args[1])} y` });
      else if (op === 'storeProvider') r = s.store.upsertProvider(args[0]);
      else if (op === 'listen') r = child?.msg?.({ type: 'listening', port: 18999, url: 'http://127.0.0.1:18999' });
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
  await new Promise((r) => setTimeout(r, 50));
  for (const k of CLI_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  scenarios.push({ name, steps, files: tree(ud) });
}

await scenario('cli methods', [
  ['cliDefaults', 'claude'],
  ['cliModels'],
  ['upsertProvider', { name: 'My Proxy', urls: { chat: 'https://proxy.example.com/v1' }, newKeys: [{ value: 'sk-proxy-aaaaaaaaaaaa' }], models: [
    { id: 'gpt-4o', enabled: true, label: 'GPT 4o', reasoning: true, vision: true, ctx: 200000, maxOutput: 64000 },
    { id: 'gpt-4o-mini', enabled: false },
    { id: 'no-tools', enabled: true, toolCalling: false },
    { id: 'plain', enabled: true },
  ] }],
  ['upsertProvider', { name: 'Off', enabled: false, urls: { chat: 'https://off.example.com/v1' }, models: [{ id: 'x', enabled: true }] }],
  ['cliModels'],
  ['setAssignment', 'claude', { newTabSource: 'thirdParty', newTabAccountId: 'acc-1', models: { main: 'my-proxy/gpt-4o', tiers: { opus: 'my-proxy/plain' }, small: 'env-deepseek/deepseek-chat', subagent: 'my-proxy/plain' } }],
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
  ['officialEnv', { A: 'http://127.0.0.1:18999', B: 'http://127.0.0.1:18999/v1', C: 'http://127.0.0.1:18999/', D: 'nomi-tab-abc', E: 'nomi-gw-x', F: 'keep', G: '', H: 'http://127.0.0.1:18999/v2', I: 'nomi-tabx' }],
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
  ['storeProvider', { id: 'raw1', name: 'Raw 1', enabled: 1, wire: 'chat', urls: { chat: 'https://raw1.example.com/v1' }, keys: [], models: rawModels }],
  ['storeProvider', { id: 'raw2', name: 'Raw 2', enabled: 'on', wire: 'chat', urls: { chat: 'https://raw2.example.com/v1' }, keys: [], models: [{ id: 'z', enabled: true }] }],
  ['storeProvider', { id: 'raw3', name: 'Raw 3', enabled: 0, wire: 'chat', urls: { chat: 'https://raw3.example.com/v1' }, keys: [], models: [{ id: 'z', enabled: true }] }],
  ['storeProvider', { id: 'raw4', name: 'Raw 4', enabled: '', wire: 'chat', urls: { chat: 'https://raw4.example.com/v1' }, keys: [], models: [{ id: 'z', enabled: true }] }],
  ['storeProvider', { id: 'raw5', name: 'Raw 5', wire: 'chat', urls: { chat: 'https://raw5.example.com/v1' }, keys: [], models: [{ id: 'z', enabled: true }] }],
  ['cliModels'],
  ['cliLaunch', 'claude', 't1', 'raw1/a'],
  ['cliLaunch', 'gemini', 't2', 'raw1/f'],
]);

const dir = process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/gwstore/testdata');
fs.mkdirSync(dir, { recursive: true });
const out = join(dir, 'gwcli.json');
fs.writeFileSync(out, JSON.stringify({ scenarios }, null, 1));
console.log('wrote', out, scenarios.length);
